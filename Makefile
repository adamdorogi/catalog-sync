.PHONY: infra migrate seed dev test build prod

infra:
	docker compose up -d --wait

migrate:
	npm run db:migrate

seed:
	npm run seed

dev:
	npm run dev

test:
	npm test

build:
	npm run typecheck
	npm run build

prod:
	docker compose -f docker-compose.prod.yml up -d --build
