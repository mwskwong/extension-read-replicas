import execa from 'execa'
// @ts-ignore
import { readReplicas } from '..'
import type { PrismaClient } from './client'

type LogEntry = { server: 'primary' | 'replica'; operation: string }

let logs: LogEntry[]
function createPrisma() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const clientModule = require('./client')
  const basePrisma = new clientModule.PrismaClient() as PrismaClient

  const prisma = basePrisma
    .$extends(
      readReplicas(
        {
          url: process.env.REPLICA_URL!,
        },
        (client) =>
          (client as PrismaClient).$extends({
            query: {
              $allOperations({ args, operation, query }) {
                logs.push({ server: 'replica', operation })
                return query(args)
              },
            },
          }),
      ),
    )
    .$extends({
      query: {
        $allOperations({ args, operation, query }) {
          logs.push({ server: 'primary', operation })
          return query(args)
        },
      },
    })

  return [basePrisma, prisma] as const
}

let basePrisma: ReturnType<typeof createPrisma>
let prisma: ReturnType<typeof createPrisma>

beforeAll(async () => {
  await execa('pnpm', ['prisma', 'db', 'push', '--schema', 'tests/prisma/schema.prisma'], {
    cwd: __dirname,
  })
  ;[basePrisma, prisma] = createPrisma()
})

beforeEach(async () => {
  logs = []
})

test('client throws an error when given an empty read replica list', async () => {
  const createInstance = () =>
    basePrisma.$extends(
      readReplicas({
        url: [],
      }),
    )

  expect(createInstance).toThrowError('At least one replica URL must be specified')
})

test('read query is executed against replica', async () => {
  await prisma.user.findMany()

  expect(logs).toEqual([{ server: 'replica', operation: 'findMany' }])
})

test('write query is executed against primary', async () => {
  await prisma.user.updateMany({ data: {} })

  expect(logs).toEqual([{ server: 'primary', operation: 'updateMany' }])
})

test('read query is executed against primary if $primary() is used', async () => {
  await prisma.$primary().user.findMany()

  // extension exits before calling further ones (including logging), hence, the logs
  // will be empty in this case
  expect(logs).toEqual([])
})

test('transactional queries are executed against primary (sequential)', async () => {
  await prisma.$transaction([prisma.user.findMany(), prisma.user.updateMany({ data: {} })])
  expect(logs).toEqual([
    { server: 'primary', operation: 'findMany' },
    { server: 'primary', operation: 'updateMany' },
  ])
})

test('transactional queries are executed against primary (itx)', async () => {
  await prisma.$transaction(async (tx) => {
    await tx.user.findMany()
    await tx.user.updateMany({ data: {} })
  })
  expect(logs).toEqual([
    { server: 'primary', operation: 'findMany' },
    { server: 'primary', operation: 'updateMany' },
  ])
})

afterAll(async () => {
  await prisma.$disconnect()
})
