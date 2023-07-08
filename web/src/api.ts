import axios from 'axios'

export const api = axios.create({ baseURL: '/api', timeout: 30_000 })

export type Mode = 'hybrid' | 'lexical' | 'semantic'
export type Tier = 'RETAIL' | 'TRADE' | 'WHOLESALE'

export interface Stock {
  warehouseCode: string
  onHand: number
  reserved: number
}

export interface Product {
  id: string
  revision: string
  sku: string
  mpn: string
  title: string
  brand: string
  category: string
  basePriceCents: number
  inventory: Stock[]
}

export interface Hit {
  product: Product
  unitPriceCents: number
  score: {
    lexicalRank: number | null
    vectorRank: number | null
    lexicalScore: number | null
    vectorScore: number | null
    rrfScore: number | null
  }
  indexedDocument: Record<string, unknown>
}

export interface Bucket {
  value: string
  count: number
}

export interface SearchResult {
  hits: Hit[]
  total: number
  page: number
  pageSize: number
  tookMs: number
  index: string
  facets: {
    categories: Bucket[]
    brands: Bucket[]
    warehouses: Bucket[]
    attributes: Record<string, Bucket[]>
    inStockCount: number
    price: { min: number | null; max: number | null }
  }
}

export interface ReindexJob {
  id: string
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'
  targetIndex: string | null
  processed: number
  total: number
  error: string | null
}

export interface OpsStats {
  outboxPending: number | null
  kafka: {
    topic: string
    groupId: string
    totalLag: number
    partitions: Array<{ partition: number; lag: number }>
  } | null
  search: { documents: number; primaryShards: number; indices: string[] } | null
  bulk: { docsPerSecond: number; p95Ms: number; indexedDocs: number; windowSeconds: number } | null
  reindex: ReindexJob | null
  errors: Record<string, string>
}

export interface DeadLetter {
  id: string
  sourceTopic: string
  sourcePartition: number
  sourceOffset: string
  messageKey: string | null
  payload: unknown
  reason: string
  status: string
  createdAt: string
  resolvedAt: string | null
}

export function errorMessage(error: unknown) {
  if (axios.isAxiosError(error)) {
    const body = error.response?.data
    if (typeof body?.error === 'string') return body.error
    if (typeof body?.message === 'string') return body.message
  }
  return error instanceof Error ? error.message : 'Request failed'
}

const money = new Intl.NumberFormat('en-AU', {
  style: 'currency',
  currency: 'AUD',
  currencyDisplay: 'narrowSymbol',
})

export const formatPrice = (cents: number) => money.format(cents / 100)
export const amount = (value: number) => value.toLocaleString('en-AU')
