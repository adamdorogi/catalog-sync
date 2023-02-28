# catalog-sync

poc for syncing postgres erp product/stock changes -> kafka -> opensearch.

## local infra

```sh
docker compose up -d
```

Postgres on 5432, Kafka on 9092, OpenSearch on 9200.

opensearch needs discovery.type=single-node and 512m heap locally.
redpanda exposes the kafka api on localhost.
check container logs if a port is already in use.
