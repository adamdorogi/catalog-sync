import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Alert, Badge, Button, Card, Form, Modal, Stack, Table } from 'react-bootstrap'
import { amount, api, errorMessage } from './api.js'
import type { DeadLetter } from './api.js'

export function Imports() {
  const [messages, setMessages] = useState<DeadLetter[]>()
  const [dlqError, setDlqError] = useState('')
  const [uploadError, setUploadError] = useState('')
  const [uploadResult, setUploadResult] = useState<{ rowsUpserted: number; eventsQueued: number }>()
  const [reload, setReload] = useState(0)
  const [uploading, setUploading] = useState(false)
  const [working, setWorking] = useState<string>()
  const [details, setDetails] = useState<DeadLetter>()
  const [discard, setDiscard] = useState<DeadLetter>()
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    let timeout: number
    async function list() {
      try {
        const { data } = await api.get<{ messages: DeadLetter[] }>('/admin/dlq', { signal: controller.signal })
        setMessages(data.messages)
        setDlqError('')
      } catch (failure) {
        if (!controller.signal.aborted) setDlqError(errorMessage(failure))
      }
      if (!controller.signal.aborted) timeout = window.setTimeout(() => void list(), 5_000)
    }
    void list()
    return () => {
      controller.abort()
      window.clearTimeout(timeout)
    }
  }, [reload])

  async function upload(event: FormEvent) {
    event.preventDefault()
    const file = input.current?.files?.[0]
    if (!file) return
    setUploading(true)
    setUploadError('')
    setUploadResult(undefined)
    const body = new FormData()
    body.append('file', file)
    try {
      const { data } = await api.post<{ rowsUpserted: number; eventsQueued: number }>('/imports/csv', body)
      setUploadResult(data)
      if (input.current) input.current.value = ''
    } catch (failure) {
      setUploadError(errorMessage(failure))
    } finally {
      setUploading(false)
    }
  }

  async function update(message: DeadLetter, action: 'replay' | 'discard') {
    setWorking(message.id)
    try {
      await api.post(`/admin/dlq/${encodeURIComponent(message.id)}/${action}`)
      setDiscard(undefined)
      setReload((value) => value + 1)
    } catch (failure) {
      setDlqError(errorMessage(failure))
      setDiscard(undefined)
    } finally {
      setWorking(undefined)
    }
  }

  return (
    <>
      <h1 className="h4 mb-3">CSV Import & DLQ</h1>
      <Card className="mb-3">
        <Card.Header as="h2" className="h6 mb-0">Supplier CSV upload</Card.Header>
        <Card.Body>
          <Form onSubmit={(event) => void upload(event)}>
            <Form.Group controlId="supplier-csv" className="mb-2">
              <Form.Label className="small fw-semibold">CSV file</Form.Label>
              <Form.Control type="file" size="sm" ref={input} accept=".csv,text/csv" required disabled={uploading} />
            </Form.Group>
            <Form.Text>
              Use <code>sku</code> with <code>base_price_cents</code>, or <code>warehouse_code</code> and <code>on_hand</code>.
              New products also need <code>title</code>.
            </Form.Text>
            <div className="mt-3"><Button size="sm" type="submit" disabled={uploading}>{uploading ? 'Importing' : 'Upload CSV'}</Button></div>
          </Form>
          {uploadError && <Alert variant="danger" className="mt-3 mb-0 py-2">{uploadError}</Alert>}
          {uploadResult && (
            <Alert variant="success" className="mt-3 mb-0 py-2" role="status">
              {amount(uploadResult.rowsUpserted)} rows upserted. {amount(uploadResult.eventsQueued)} outbox events queued.
            </Alert>
          )}
        </Card.Body>
      </Card>
      <Card>
        <Card.Header className="d-flex justify-content-between align-items-center">
          <h2 className="h6 mb-0">Dead-Letter Queue</h2>
          <Button size="sm" variant="outline-secondary" onClick={() => setReload((value) => value + 1)}>Refresh</Button>
        </Card.Header>
        {dlqError && <Alert variant="danger" className="m-2 py-2">{dlqError}</Alert>}
        <Table striped bordered hover size="sm" responsive className="catalog-table mb-0">
          <thead className="table-light">
            <tr><th scope="col">Received</th><th scope="col">Partition / Offset</th><th scope="col">Key</th>
              <th scope="col">Reason</th><th scope="col">Status</th><th scope="col">Actions</th></tr>
          </thead>
          <tbody>
            {messages?.map((message) => {
              const open = message.status === 'PENDING'
              return (
                <tr key={message.id}>
                  <td>{new Date(message.createdAt).toLocaleString()}</td>
                  <td>{message.sourcePartition} / {message.sourceOffset}</td>
                  <td><code>{message.messageKey ?? '-'}</code></td>
                  <td>{message.reason}</td>
                  <td><Badge bg={open ? 'warning' : 'secondary'} text={open ? 'dark' : undefined}>{message.status}</Badge></td>
                  <td>
                    <Stack direction="horizontal" gap={1}>
                      <Button variant="outline-secondary" size="sm" onClick={() => setDetails(message)}>Payload</Button>
                      <Button variant="outline-primary" size="sm" disabled={!open || Boolean(working)}
                        onClick={() => void update(message, 'replay')}>Replay</Button>
                      <Button variant="outline-danger" size="sm" disabled={!open || Boolean(working)}
                        onClick={() => setDiscard(message)}>Discard</Button>
                    </Stack>
                  </td>
                </tr>
              )
            })}
            {messages?.length === 0 && <tr><td colSpan={6} className="text-muted">No dead-letter messages.</td></tr>}
          </tbody>
        </Table>
      </Card>
      {details && (
        <Modal show onHide={() => setDetails(undefined)} size="lg" scrollable>
          <Modal.Header closeButton><Modal.Title as="h2" className="h5">Dead-letter payload</Modal.Title></Modal.Header>
          <Modal.Body>
            <p>{details.reason}</p>
            <pre className="detail-json border bg-light p-2 mb-0">{JSON.stringify(details.payload, null, 2)}</pre>
          </Modal.Body>
        </Modal>
      )}
      {discard && (
        <Modal show onHide={() => setDiscard(undefined)}>
          <Modal.Header closeButton><Modal.Title as="h2" className="h5">Discard message?</Modal.Title></Modal.Header>
          <Modal.Body>Message {discard.id} will be closed without replay.</Modal.Body>
          <Modal.Footer>
            <Button size="sm" variant="secondary" onClick={() => setDiscard(undefined)}>Cancel</Button>
            <Button size="sm" variant="danger" disabled={Boolean(working)} onClick={() => void update(discard, 'discard')}>Discard</Button>
          </Modal.Footer>
        </Modal>
      )}
    </>
  )
}
