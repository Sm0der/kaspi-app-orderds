# Warehouse & Production Management System

Система управления производством и складом для мебельного предприятия.

## Project Setup

### Prerequisites
- Node.js 18+
- npm or yarn
- Supabase account
- PostgreSQL database (via Supabase)

### Installation

1. **Clone and install dependencies:**
```bash
npm install
```

2. **Create Supabase project:**
   - Go to https://supabase.com
   - Create a new project
   - Copy your project URL and anon key

3. **Configure environment variables:**

Create `.env.local`:
```
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
DATABASE_URL=postgresql://user:password@host:port/database
JWT_SECRET=your_jwt_secret_key

NEXT_PUBLIC_KASPI_API_URL=https://api.kaspi.kz/api/v2
KASPI_API_TOKEN_STORE1=your_art_room_token
KASPI_API_TOKEN_STORE2=your_kuhni_kz_token

NEXT_PUBLIC_APP_URL=http://localhost:3000
NODE_ENV=development
```

4. **Create database schema:**

Push Prisma schema to Supabase:
```bash
npx prisma migrate dev --name init
```

5. **Run development server:**
```bash
npm run dev
```

Open http://localhost:3000

## Key Features - Phase 1 ✓

- Authentication system (JWT)
- Barcode scanning for goods receipt
- Order locking during picking
- Multi-item order assembly with validation
- Automatic order status management

## API Endpoints

### Auth
- `POST /api/auth/login`
- `GET /api/auth/me`

### Warehouse
- `POST /api/warehouse/receive/scan-barcode`
- `GET /api/warehouse/ship/orders`
- `POST /api/warehouse/ship/orders/:id/start`
- `POST /api/warehouse/ship/orders/:id/scan-barcode`
- `POST /api/warehouse/ship/orders/:id/complete`

## Database Schema

See `prisma/schema.prisma` for complete schema with all tables and relationships.

The database is SHARED with the Kaspi orders dashboard (`kaspi-app-orderds`).
This app does not own stores, orders or order items - it reads them.

Read-only, owned by the orders app:
- Store, Order, OrderItem, Product

Owned here:
- ProductionUser (shop-floor logins; the dashboard uses Supabase Auth instead)
- Workshop, Warehouse
- WarehouseItem - a manufactured product, the unit of stock
- WarehouseItemSku - which Kaspi SKUs that product is sold under (one item, many SKUs)
- Barcode, ProductionItem, WorkshopOperation, WarehouseMovement
- OrderPicking / OrderItemPicking - picking state, kept out of `orders` because
  the Kaspi sync rewrites those rows on every run
