import { useEffect, useState } from 'react'
import { Alert, Badge, Button, Card, Col, ProgressBar, Row, Stack, Table } from 'react-bootstrap'
import { amount, api, errorMessage } from './api.js'
import type { OpsStats, ReindexJob } from './api.js'

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <Col>
      <Card className="h-100">
        <Card.Header className="small fw-semibold">{label}</Card.Header>
        <Card.Body>
          <div className="h4 mb-1 font-monospace">{value}</div>
          <div className="small text-muted">{detail}</div>
        </Card.Body>
      </Card>
    </Col>
  )
}

function ReindexStatus({ job }: { job: ReindexJob | null | undefined }) {
  if (!job) return <p className="text-muted small mb-3">No reindex jobs.</p>
  const active = job.status === 'QUEUED' || job.status === 'RUNNING'
  const progress = job.status === 'SUCCEEDED' ? 100 : job.total ? Math.min(100, job.processed * 100 / job.total) : 0
  const variant = job.status === 'FAILED' ? 'danger' : job.status === 'SUCCEEDED' ? 'success' : 'primary'
  return (
    <div className="mb-3">
      <div className="d-flex gap-2 align-items-center mb-2 small">
        <Badge bg={variant}>{job.status}</Badge>
        <span>{amount(job.processed)} / {amount(job.total)} products</span>
        {job.targetIndex && <code>{job.targetIndex}</code>}
      </div>
      <ProgressBar now={progress} variant={variant} animated={active} striped={active} label={`${Math.floor(progress)}%`} />
      {job.error && <Alert variant="danger" className="mt-2 py-2">{job.error}</Alert>}
    </div>
  )
}

export function Pipeline() {
  const [stats, setStats] = useState<OpsStats>()
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [message, setMessage] = useState('')
  const [action, setAction] = useState<'burst' | 'reindex'>()
  const [sampleUntil, setSampleUntil] = useState(0)
  const [peakLag, setPeakLag] = useState<number>()
  const pending = stats?.reindex?.status === 'QUEUED' || stats?.reindex?.status === 'RUNNING'

  useEffect(() => {
    const controller = new AbortController()
    let timeout: number
    async function refresh() {
      try {
        const { data } = await api.get<OpsStats>('/ops/stats', { signal: controller.signal })
        setStats(data)
        if (Date.now() < sampleUntil && data.kafka) {
          const lag = data.kafka.totalLag
          setPeakLag((peak) => Math.max(peak ?? 0, lag))
        }
        setError('')
      } catch (failure) {
        if (!controller.signal.aborted) setError(errorMessage(failure))
      }
      if (!controller.signal.aborted) {
        const interval = Date.now() < sampleUntil ? 200 : 750
        timeout = window.setTimeout(() => void refresh(), interval)
      }
    }
    void refresh()
    return () => {
      controller.abort()
      window.clearTimeout(timeout)
    }
  }, [sampleUntil])

  async function run(operation: 'burst' | 'reindex') {
    setAction(operation)
    setMessage('')
    setActionError('')
    try {
      if (operation === 'burst') {
        setPeakLag(undefined)
        setSampleUntil(Date.now() + 5_000)
        const { data } = await api.post<{ eventsQueued?: number }>('/admin/burst', { count: 500 })
        setMessage(`${amount(data.eventsQueued ?? 500)} stock events queued.`)
      } else {
        const { data } = await api.post<{ job: ReindexJob }>('/admin/reindex')
        setStats((current) => current ? { ...current, reindex: data.job } : current)
        setMessage('Reindex queued.')
      }
    } catch (failure) {
      setActionError(errorMessage(failure))
    } finally {
      setAction(undefined)
    }
  }

  return (
    <>
      <h1 className="h4 mb-3">Pipeline & Lag</h1>
      {error && <Alert variant="danger">{error}</Alert>}
      {Object.entries(stats?.errors ?? {}).map(([service, issue]) => (
        <Alert key={service} variant="warning" className="py-2">{service}: {issue}</Alert>
      ))}
      <Row xs={1} sm={2} lg={4} className="g-3 mb-3">
        <Metric label="Outbox Pending" value={stats?.outboxPending == null ? '-' : amount(stats.outboxPending)}
          detail="Unpublished Postgres rows" />
        <Metric label="Kafka Consumer Lag" value={stats?.kafka ? amount(stats.kafka.totalLag) : '-'}
          detail={stats?.kafka
            ? `${stats.kafka.partitions.length} partitions${peakLag == null ? '' : ` | burst peak ${amount(peakLag)}`}`
            : 'Catalog consumer group'} />
        <Metric label="OpenSearch Docs / Primary Shards"
          value={stats?.search ? `${amount(stats.search.documents)} / ${amount(stats.search.primaryShards)}` : '-'}
          detail="catalog_current" />
        <Metric label="Bulk Index Throughput / p95"
          value={stats?.bulk ? `${amount(stats.bulk.docsPerSecond)} / ${amount(stats.bulk.p95Ms)} ms` : '-'}
          detail={stats?.bulk ? `Docs/s and bulk duration, last ${stats.bulk.windowSeconds}s` : 'Docs/s and bulk duration'} />
      </Row>

      <Card className="mb-3">
        <Card.Header as="h2" className="h6 mb-0">Pipeline controls</Card.Header>
        <Card.Body>
          <Stack direction="horizontal" gap={2} className="flex-wrap">
            <Button size="sm" disabled={pending || action === 'reindex'}
              onClick={() => void run('reindex')}>Trigger Zero-Downtime Alias Reindex</Button>
            <Button size="sm" variant="outline-primary" disabled={action === 'burst'}
              onClick={() => void run('burst')}>Fire 500-event burst</Button>
          </Stack>
          {actionError && <Alert variant="danger" className="mt-3 mb-0 py-2">{actionError}</Alert>}
          {message && <p className="small mt-2 mb-0" role="status">{message}</p>}
        </Card.Body>
      </Card>

      <Row className="g-3">
        <Col lg={7}>
          <Card>
            <Card.Header as="h2" className="h6 mb-0">Index alias</Card.Header>
            <Card.Body>
              <ReindexStatus job={stats?.reindex} />
              <Table striped bordered hover size="sm" responsive className="mb-0">
                <thead className="table-light"><tr><th scope="col">Alias</th><th scope="col">Active index</th></tr></thead>
                <tbody>
                  {(stats?.search?.indices ?? []).map((index) => (
                    <tr key={index}><td><code>catalog_current</code></td><td><code>{index}</code></td></tr>
                  ))}
                  {!stats?.search?.indices.length && <tr><td colSpan={2} className="text-muted">No index available.</td></tr>}
                </tbody>
              </Table>
            </Card.Body>
          </Card>
        </Col>
        <Col lg={5}>
          <Card>
            <Card.Header as="h2" className="h6 mb-0">Partition lag</Card.Header>
            <Card.Body>
              <p className="small text-muted"><code>{stats?.kafka?.topic ?? 'catalog.events.v1'}</code> {stats?.kafka?.groupId}</p>
              <Table striped bordered hover size="sm" responsive className="mb-0">
                <thead className="table-light"><tr><th scope="col">Partition</th><th scope="col">Pending offsets</th></tr></thead>
                <tbody>
                  {stats?.kafka?.partitions.map(({ partition, lag }) => (
                    <tr key={partition}>
                      <td>{partition}</td>
                      <td className="d-flex align-items-center gap-3">
                        <span>{amount(lag)}</span>
                        <ProgressBar className="lag-bar flex-grow-1" aria-label={`Partition ${partition} share of lag`}
                          now={stats.kafka?.totalLag ? 100 * lag / stats.kafka.totalLag : 0} />
                      </td>
                    </tr>
                  ))}
                  {!stats?.kafka?.partitions.length && <tr><td colSpan={2} className="text-muted">No offsets available.</td></tr>}
                </tbody>
              </Table>
            </Card.Body>
          </Card>
        </Col>
      </Row>
    </>
  )
}
