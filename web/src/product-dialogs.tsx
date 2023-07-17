import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Alert, Button, Col, Form, Modal, Row, Table } from 'react-bootstrap'
import { api, errorMessage } from './api.js'
import type { Product, SearchResult } from './api.js'

const defaultWarehouses = ['BNE-01', 'SYD-02', 'MEL-01']

export function EditProduct({ product, defaultWarehouse, onHide, onIndexed, onPending }: {
  product: Product
  defaultWarehouse: string
  onHide: () => void
  onIndexed: (sku: string, elapsed: number) => void
  onPending: (sku: string) => void
}) {
  const [warehouse, setWarehouse] = useState(defaultWarehouse || product.inventory[0]?.warehouseCode || defaultWarehouses[0])
  const initialStock = product.inventory.find((item) => item.warehouseCode === warehouse)
  const [onHand, setOnHand] = useState(String(initialStock?.onHand ?? 0))
  const [reserved, setReserved] = useState(String(initialStock?.reserved ?? 0))
  const [price, setPrice] = useState((product.basePriceCents / 100).toFixed(2))
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const controller = useRef<AbortController>()
  const warehouses = [...new Set([...defaultWarehouses, ...product.inventory.map((item) => item.warehouseCode), warehouse])]

  useEffect(() => () => controller.current?.abort(), [])

  function changeWarehouse(code: string) {
    const stock = product.inventory.find((item) => item.warehouseCode === code)
    setWarehouse(code)
    setOnHand(String(stock?.onHand ?? 0))
    setReserved(String(stock?.reserved ?? 0))
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    setError('')
    const original = product.inventory.find((item) => item.warehouseCode === warehouse)
    const basePriceCents = Math.round(Number(price) * 100)
    const inventory = { warehouseCode: warehouse, onHand: Number(onHand), reserved: Number(reserved) }
    if (inventory.reserved > inventory.onHand) {
      setError('Reserved stock cannot exceed stock on hand.')
      return
    }

    const changes: { basePriceCents?: number; inventory?: typeof inventory } = {}
    if (basePriceCents !== product.basePriceCents) changes.basePriceCents = basePriceCents
    if (inventory.onHand !== (original?.onHand ?? 0) || inventory.reserved !== (original?.reserved ?? 0)) {
      changes.inventory = inventory
    }
    if (Object.keys(changes).length === 0) {
      onHide()
      return
    }

    const start = performance.now()
    const abort = new AbortController()
    const { signal } = abort
    controller.current = abort
    setStatus('Saving to Postgres')
    let revision: string
    try {
      const { data } = await api.patch<{ product: Product }>(
        `/products/${encodeURIComponent(product.sku)}`, changes, { signal },
      )
      revision = data.product.revision
    } catch (failure) {
      if (signal.aborted) return
      setError(errorMessage(failure))
      setStatus('')
      return
    }

    setStatus('Waiting for search indexing')
    const deadline = performance.now() + 7_000
    while (!signal.aborted && performance.now() < deadline) {
      try {
        const { data } = await api.get<SearchResult>('/search', {
          params: { sku: product.sku, mode: 'lexical', pageSize: 1, facets: 'false' },
          timeout: 2_000,
          signal,
        })
        const indexed = data.hits[0]?.product.revision
        if (indexed != null && BigInt(indexed) >= BigInt(revision)) {
          onIndexed(product.sku, Math.round(performance.now() - start))
          onHide()
          return
        }
      } catch {
        if (signal.aborted) return
      }
      await new Promise((resolve) => window.setTimeout(resolve, 180))
    }
    if (!signal.aborted) {
      onPending(product.sku)
      onHide()
    }
  }

  return (
    <Modal show onHide={onHide} backdrop={status ? 'static' : true} keyboard={!status}>
      <Form onSubmit={(event) => void save(event)}>
        <Modal.Header closeButton={!status}><Modal.Title as="h2" className="h5">Quick Edit Stock/Price</Modal.Title></Modal.Header>
        <Modal.Body>
          <p className="mb-3"><code>{product.sku}</code> <span className="ms-2">{product.title}</span></p>
          {error && <Alert variant="danger">{error}</Alert>}
          <Form.Group controlId="edit-warehouse" className="mb-3">
            <Form.Label>Warehouse</Form.Label>
            <Form.Select size="sm" disabled={Boolean(status)} value={warehouse} onChange={(event) => changeWarehouse(event.target.value)}>
              {warehouses.map((code) => <option key={code}>{code}</option>)}
            </Form.Select>
          </Form.Group>
          <Row className="g-3">
            <Form.Group as={Col} controlId="edit-on-hand">
              <Form.Label>On hand</Form.Label>
              <Form.Control required size="sm" disabled={Boolean(status)} type="number" min={0} step={1}
                value={onHand} onChange={(event) => setOnHand(event.target.value)} />
            </Form.Group>
            <Form.Group as={Col} controlId="edit-reserved">
              <Form.Label>Reserved</Form.Label>
              <Form.Control required size="sm" disabled={Boolean(status)} type="number" min={0} step={1}
                value={reserved} onChange={(event) => setReserved(event.target.value)} />
            </Form.Group>
            <Form.Group as={Col} controlId="edit-price">
              <Form.Label>Base price (AUD)</Form.Label>
              <Form.Control required size="sm" disabled={Boolean(status)} type="number" min={0} step=".01"
                value={price} onChange={(event) => setPrice(event.target.value)} />
            </Form.Group>
          </Row>
        </Modal.Body>
        <Modal.Footer>
          <span role="status" className="small text-muted me-auto">{status}</span>
          <Button size="sm" variant="secondary" onClick={onHide} disabled={Boolean(status)}>Cancel</Button>
          <Button size="sm" type="submit" disabled={Boolean(status)}>Save changes</Button>
        </Modal.Footer>
      </Form>
    </Modal>
  )
}
