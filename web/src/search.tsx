import { useEffect, useId, useState } from 'react'
import { Alert, Button, Card, Col, Form, InputGroup, Row, Spinner, Stack, Table } from 'react-bootstrap'
import { amount, api, errorMessage, formatPrice } from './api.js'
import type { Bucket, Hit, Mode, SearchResult, Tier } from './api.js'
import { EditProduct, ExplainScore } from './product-dialogs.js'

const modes: { value: Mode; label: string }[] = [
  { value: 'hybrid', label: 'Hybrid RRF' },
  { value: 'lexical', label: 'BM25 Lexical' },
  { value: 'semantic', label: 'Vector k-NN' },
]
const warehouses = ['BNE-01', 'SYD-02', 'MEL-01']
const pageSize = 25

function toggle(values: string[], item: string) {
  return values.includes(item) ? values.filter((value) => value !== item) : [...values, item]
}

function Facet({ title, buckets, selected, onToggle }: {
  title: string
  buckets: Bucket[]
  selected: string[]
  onToggle: (value: string) => void
}) {
  const listId = useId()
  const missing = selected.filter((value) => !buckets.some((bucket) => bucket.value === value))
  const options = [...buckets, ...missing.map((value) => ({ value, count: 0 }))]
  if (options.length === 0) return null

  return (
    <fieldset className="border-top pt-2 mt-3">
      <legend className="fs-6 fw-semibold mb-1">{title}</legend>
      <div className="facet-options">
        {options.map(({ value, count }, index) => (
          <Form.Check
            key={value}
            id={`${listId}-${index}`}
            className="small my-1"
            type="checkbox"
            checked={selected.includes(value)}
            onChange={() => onToggle(value)}
            label={<>{value} <span className="text-muted">({amount(count)})</span></>}
          />
        ))}
      </div>
    </fieldset>
  )
}

function ProductRow({ hit, onEdit, onExplain }: {
  hit: Hit
  onEdit: (hit: Hit) => void
  onExplain: (hit: Hit) => void
}) {
  const stock = new Map(hit.product.inventory.map((item) => [
    item.warehouseCode,
    item.onHand - item.reserved,
  ]))

  return (
    <tr>
      <td><code>{hit.product.sku}</code></td>
      <td>
        <div>{hit.product.title}</div>
        <small className="text-muted">{hit.product.mpn}</small>
      </td>
      <td>{hit.product.brand}</td>
      <td>{hit.product.category}</td>
      <td className="text-nowrap small">{warehouses.map((code) => amount(stock.get(code) ?? 0)).join(' / ')}</td>
      <td className="text-end text-nowrap">{formatPrice(hit.unitPriceCents)}</td>
      <td>
        <Stack direction="horizontal" gap={1}>
          <Button
            size="sm" variant="outline-primary" onClick={() => onEdit(hit)}
            aria-label={`Quick edit stock or price for ${hit.product.sku}`}
          >
            <i className="bi bi-pencil-square me-1" aria-hidden="true" /> Edit
          </Button>
          <Button
            size="sm" variant="outline-secondary" onClick={() => onExplain(hit)}
            aria-label={`Explain score for ${hit.product.sku}`}
          >
            Explain
          </Button>
        </Stack>
      </td>
    </tr>
  )
}

export function CatalogSearch() {
  const [q, setQuery] = useState('')
  const [mode, setMode] = useState<Mode>('hybrid')
  const [tier, setTier] = useState<Tier>('RETAIL')
  const [inStock, setInStock] = useState(false)
  const [warehouse, setWarehouse] = useState('')
  const [categories, setCategories] = useState<string[]>([])
  const [brands, setBrands] = useState<string[]>([])
  const [attributes, setAttributes] = useState<Record<string, string[]>>({})
  const [quantity, setQuantity] = useState('1')
  const [minPrice, setMinPrice] = useState('')
  const [maxPrice, setMaxPrice] = useState('')
  const [page, setPage] = useState(1)
  const [refresh, setRefresh] = useState(0)
  const [result, setResult] = useState<SearchResult>()
  const [pending, setPending] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<Hit>()
  const [explaining, setExplaining] = useState<Hit>()

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({
        q: q.trim(), mode, tier, inStock: String(inStock),
        page: String(page), pageSize: String(pageSize),
        quantity: String(Math.max(1, Math.trunc(Number(quantity) || 1))),
      })
      if (warehouse) params.set('warehouse', warehouse)
      if (minPrice) params.set('minPriceCents', String(Math.round(Number(minPrice) * 100)))
      if (maxPrice) params.set('maxPriceCents', String(Math.round(Number(maxPrice) * 100)))
      categories.forEach((category) => params.append('category', category))
      brands.forEach((brand) => params.append('brand', brand))
      for (const [key, values] of Object.entries(attributes)) {
        values.forEach((value) => params.append('attribute', `${key}:${value}`))
      }
      setPending(true)
      setError('')
      void api.get<SearchResult>('/search', { params, signal: controller.signal })
        .then(({ data }) => setResult(data))
        .catch((failure) => {
          if (!controller.signal.aborted) setError(errorMessage(failure))
        })
        .finally(() => {
          if (!controller.signal.aborted) setPending(false)
        })
    }, 200)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [q, mode, tier, inStock, warehouse, categories, brands, attributes, quantity, minPrice, maxPrice, page, refresh])

  const facets = result?.facets
  const maxPage = Math.max(1, Math.ceil(Math.min(result?.total ?? 0, 10_000) / pageSize))

  function clearFilters() {
    setTier('RETAIL')
    setQuantity('1')
    setInStock(false)
    setWarehouse('')
    setCategories([])
    setBrands([])
    setAttributes({})
    setMinPrice('')
    setMaxPrice('')
    setPage(1)
  }

  return (
    <>
      <h1 className="h4 mb-3">Catalog Search</h1>
      <Row className="g-3">
        <Col md={3}>
          <Card>
            <Card.Header className="d-flex align-items-center justify-content-between py-2">
              <h2 className="h6 mb-0">Filters</h2>
              <Button variant="link" size="sm" className="p-0" onClick={clearFilters}>Clear</Button>
            </Card.Header>
            <Card.Body className="p-3">
              <Form.Group controlId="tier" className="mb-2">
                <Form.Label className="small fw-semibold mb-1">Tier price</Form.Label>
                <Form.Select size="sm" value={tier} onChange={(event) => { setTier(event.target.value as Tier); setPage(1) }}>
                  <option value="RETAIL">Retail</option>
                  <option value="TRADE">Trade</option>
                  <option value="WHOLESALE">Wholesale</option>
                </Form.Select>
              </Form.Group>
              <Form.Group controlId="quantity" className="mb-3">
                <Form.Label className="small fw-semibold mb-1">Order quantity</Form.Label>
                <Form.Control size="sm" type="number" min={1} step={1} value={quantity}
                  onChange={(event) => { setQuantity(event.target.value); setPage(1) }} />
              </Form.Group>
              <Form.Check
                id="in-stock" className="small mb-2" checked={inStock}
                onChange={(event) => { setInStock(event.target.checked); setPage(1) }}
                label={<>In Stock Only {facets && <span className="text-muted">({amount(facets.inStockCount)})</span>}</>}
              />
              <Form.Group controlId="warehouse">
                <Form.Label className="small fw-semibold mb-1">Warehouse</Form.Label>
                <Form.Select size="sm" value={warehouse} onChange={(event) => { setWarehouse(event.target.value); setPage(1) }}>
                  <option value="">All warehouses</option>
                  {[...new Set([...warehouses, ...(facets?.warehouses.map((bucket) => bucket.value) ?? [])])].map((code) => (
                    <option key={code} value={code}>
                      {code}{facets?.warehouses.some((bucket) => bucket.value === code)
                        ? ` (${amount(facets.warehouses.find((bucket) => bucket.value === code)!.count)})`
                        : ''}
                    </option>
                  ))}
                </Form.Select>
              </Form.Group>
              <Facet title="Category" buckets={facets?.categories ?? []} selected={categories}
                onToggle={(value) => { setCategories(toggle(categories, value)); setPage(1) }} />
              <Facet title="Brand" buckets={facets?.brands ?? []} selected={brands}
                onToggle={(value) => { setBrands(toggle(brands, value)); setPage(1) }} />
              <fieldset className="border-top pt-2 mt-3">
                <legend className="fs-6 fw-semibold mb-1">Price (AUD)</legend>
                <InputGroup size="sm">
                  <Form.Control type="number" min="0" step=".01" placeholder="Min" aria-label="Minimum price"
                    value={minPrice} onChange={(event) => { setMinPrice(event.target.value); setPage(1) }} />
                  <Form.Control type="number" min="0" step=".01" placeholder="Max" aria-label="Maximum price"
                    value={maxPrice} onChange={(event) => { setMaxPrice(event.target.value); setPage(1) }} />
                </InputGroup>
              </fieldset>
              {Object.keys(facets?.attributes ?? {}).length > 0 && (
                <details className="mt-3">
                  <summary className="small fw-semibold">Product attributes</summary>
                  {[...new Set([...Object.keys(facets?.attributes ?? {}), ...Object.keys(attributes)])].sort().map((key) => (
                    <Facet key={key} title={key.replaceAll('_', ' ')} buckets={facets?.attributes[key] ?? []}
                      selected={attributes[key] ?? []} onToggle={(value) => {
                        setAttributes({ ...attributes, [key]: toggle(attributes[key] ?? [], value) })
                        setPage(1)
                      }} />
                  ))}
                </details>
              )}
            </Card.Body>
          </Card>
        </Col>
        <Col md={9}>
          <Card className="mb-3">
            <Card.Body className="py-3">
              <Form onSubmit={(event) => { event.preventDefault(); setRefresh(refresh + 1) }}>
                <InputGroup size="sm" className="mb-2">
                  <InputGroup.Text><i className="bi bi-search" aria-hidden="true" /></InputGroup.Text>
                  <Form.Control type="search" maxLength={250} autoComplete="off" aria-label="Search catalog" placeholder="SKU, part number, or description"
                    value={q} onChange={(event) => { setQuery(event.target.value); setPage(1) }} />
                  <Button type="submit" variant="primary">Search</Button>
                </InputGroup>
                <fieldset className="small">
                  <legend className="visually-hidden">Search mode</legend>
                  {modes.map(({ value, label }) => (
                    <Form.Check inline key={value} id={`mode-${value}`} type="radio" name="mode" label={label}
                      checked={mode === value} onChange={() => { setMode(value); setPage(1) }} />
                  ))}
                </fieldset>
              </Form>
            </Card.Body>
          </Card>
          {error && <Alert variant="danger" className="py-2">{error}</Alert>}
          {notice && (
            <Alert variant="success" className="py-2" dismissible onClose={() => setNotice('')}>{notice}</Alert>
          )}
          <Card>
            <Card.Header className="small d-flex align-items-center gap-2 flex-wrap" aria-live="polite">
              {pending && <Spinner animation="border" size="sm" aria-label="Searching" />}
              {result ? (
                <>
                  <span><strong>{amount(result.total)}</strong> results in <strong>{result.tookMs} ms</strong></span>
                  <span className="text-muted">|</span>
                  <span>index <code>{result.index}</code></span>
                </>
              ) : <span>{pending ? 'Searching catalog' : 'Catalog results'}</span>}
            </Card.Header>
            <Table striped bordered hover responsive size="sm" className="catalog-table mb-0">
              <thead className="table-light">
                <tr>
                  <th scope="col">SKU</th>
                  <th scope="col">Part / Title</th>
                  <th scope="col">Brand</th>
                  <th scope="col">Category</th>
                  <th scope="col" className="text-nowrap">Stock <small>(BNE / SYD / MEL)</small></th>
                  <th scope="col" className="text-end text-nowrap">Tier Price</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {result?.hits.map((hit) => (
                  <ProductRow key={hit.product.id} hit={hit} onEdit={setEditing} onExplain={setExplaining} />
                ))}
                {result?.hits.length === 0 && (
                  <tr><td colSpan={7} className="text-muted py-3">No matching products.</td></tr>
                )}
              </tbody>
            </Table>
            {result && (
              <Card.Footer className="bg-white d-flex align-items-center justify-content-end gap-2">
                <Button size="sm" variant="outline-secondary" disabled={page <= 1 || pending} onClick={() => setPage(page - 1)}>
                  Previous
                </Button>
                <span className="small">Page {page} of {maxPage}</span>
                <Button size="sm" variant="outline-secondary" disabled={page >= maxPage || pending} onClick={() => setPage(page + 1)}>
                  Next
                </Button>
              </Card.Footer>
            )}
          </Card>
        </Col>
      </Row>
      {editing && (
        <EditProduct product={editing.product} defaultWarehouse={warehouse} onHide={() => setEditing(undefined)}
          onIndexed={(sku, elapsed) => {
            setNotice(`${sku} saved and indexed in ${elapsed} ms.`)
            setRefresh((value) => value + 1)
          }}
          onPending={(sku) => {
            setNotice(`${sku} saved to Postgres. Search indexing is pending.`)
            setRefresh((value) => value + 1)
          }} />
      )}
      {explaining && <ExplainScore hit={explaining} onHide={() => setExplaining(undefined)} />}
    </>
  )
}
