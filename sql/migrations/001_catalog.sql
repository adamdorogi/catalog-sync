CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sku TEXT NOT NULL UNIQUE,
    mpn TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    brand TEXT NOT NULL DEFAULT 'Unbranded',
    category TEXT NOT NULL DEFAULT 'Uncategorized',
    attributes JSONB NOT NULL DEFAULT '{}',
    base_price_cents INTEGER NOT NULL DEFAULT 0 CHECK (base_price_cents >= 0),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE inventory (
    product_id UUID NOT NULL REFERENCES products (id),
    warehouse_code TEXT NOT NULL,
    on_hand INTEGER NOT NULL CHECK (on_hand >= 0),
    reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (product_id, warehouse_code)
);

CREATE TABLE tier_prices (
    product_id UUID NOT NULL REFERENCES products (id),
    tier_code TEXT NOT NULL CHECK (tier_code IN ('RETAIL', 'TRADE', 'WHOLESALE')),
    min_qty INTEGER NOT NULL CHECK (min_qty > 0),
    unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
    PRIMARY KEY (product_id, tier_code, min_qty)
);
