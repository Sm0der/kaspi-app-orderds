# Setup Guide: Warehouse & Production Management System

## Step 1: Database

Do NOT create a new Supabase project. This app shares the database of the Kaspi
orders dashboard (project `aiatnvqgghdkzrbuqcmw`): the same shops, the same orders,
the same SKUs. A second database would mean a second Kaspi sync and a permanent
reconciliation problem.

Take `DATABASE_URL` from the orders API deployment (Vercel project
`kaspi-app-orderds-api` → Settings → Environment Variables), or build it from
Supabase → Settings → Database → Connection string with your own password.

The schema is already applied to that database. Prisma here is the definition of
record for the production/warehouse tables only - never run a migration that
touches `stores`, `orders`, `order_items` or `products`.

## Step 2: Environment Setup

Create `.env.local` in project root:

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
DATABASE_URL=postgresql://postgres:password@xxxxx.supabase.co:5432/postgres

# Authentication
JWT_SECRET=your_super_secret_jwt_key_min_32_chars_long

# Kaspi Integration
NEXT_PUBLIC_KASPI_API_URL=https://api.kaspi.kz/api/v2
# Kaspi-токены здесь не нужны: с Kaspi общается приложение заказов

# App
NEXT_PUBLIC_APP_URL=http://localhost:3000
NODE_ENV=development
```

## Step 3: Database Schema

The schema is already applied to the shared database. Just generate the client:

```bash
npx prisma generate
```

Do NOT run `npx prisma db push` against this database: the schema contains models
for tables owned by the orders app (`stores`, `orders`, `order_items`, `products`),
and a push would try to reshape them to Prisma's idea of them.

### Verify in Supabase
1. Go to Supabase Dashboard > SQL Editor
2. Execute:
```sql
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public'
ORDER BY table_name;
```
3. Verify these tables exist:
   - production_users, workshops, warehouses
   - warehouse_items, warehouse_item_skus
   - barcodes, production_items, workshop_operations, warehouse_movements
   - order_picking, order_item_picking
   - and, owned by the orders app: stores, orders, order_items, products

## Step 4: Seed Initial Data

Run seed script to populate demo data:

```bash
npm run prisma:seed
```

This creates only what this app owns:
- 3 workshops (Раскрой, Сборка, Упаковка)
- 2 warehouses, and attaches every unattached product to the main one
- 3 staff logins, all with password `warehouse2026` — change them after first login:
  - admin@artroom.kz (ADMIN)
  - priemka@artroom.kz (WAREHOUSE_RECEIVER)
  - otgruzka@artroom.kz (WAREHOUSE_SHIPPER)

It does NOT create shops or orders — those come from Kaspi through the orders app.
The product catalogue (`warehouse_items`) and the SKU links were filled from the
existing `products` table by migration.

## Step 5: Run Development Server

```bash
npm run dev
```

Open http://localhost:3000

## Step 6: Test the System

### Login
- URL: http://localhost:3000/login
- Use credentials from seed data (see Step 4)

### Test Warehouse Receive
1. Login as `priemka@artroom.kz`
2. Click "Receive Goods"
3. Scan barcode: `4600123456780`
4. Should show: "Kitchen Chair" received

### Test Warehouse Shipping
1. Login as `otgruzka@artroom.kz`
2. Click "Ship Orders"
3. Click order "KO-12345"
4. Scan barcodes to pick items:
   - `4600123456780` (Kitchen Chair - need 2)
   - `4600123456781` (Kitchen Chair - need 2)
   - `4600123456782` (Dining Table - need 1)
5. When all items scanned, "Complete & Ship" button enables
6. Click to mark order as shipped

## Troubleshooting

### "Error: connect ECONNREFUSED"
**Cause**: DATABASE_URL incorrect
**Fix**:
1. Go to Supabase > Settings > Database > Connection strings
2. Use the "Node" connection string
3. Update DATABASE_URL in .env.local
4. Restart dev server

### "P1000: Authentication failed"
**Cause**: Wrong password in DATABASE_URL
**Fix**:
1. In Supabase dashboard: Settings > Database
2. Reset database password if needed
3. Update DATABASE_URL

### "Barcode not found" error
**Cause**: Barcode doesn't exist in database
**Fix**:
1. Login as admin
2. Go to Admin panel (coming soon)
3. Create barcodes through UI or directly in database:
```sql
INSERT INTO "Barcode" (id, "barcodeValue", "warehouseItemId", status)
VALUES (gen_random_uuid(), '4600123456780', 'item1', 'IN_STOCK');
```

### "User not found" during login
**Cause**: Seed didn't run or user was deleted
**Fix**:
```bash
npm run prisma:seed
```

### Port 3000 already in use
**Fix**:
```bash
npm run dev -- -p 3001
```

## Project Structure

```
warehouse-production-app/
├── prisma/
│   ├── schema.prisma      # Database schema definition
│   └── seed.ts            # Seed data script
├── src/
│   ├── app/
│   │   ├── api/           # API routes
│   │   ├── login/         # Login page
│   │   ├── dashboard/     # Main dashboard
│   │   └── warehouse/     # Warehouse pages
│   ├── lib/               # Utilities (auth, db, jwt)
│   ├── types/             # TypeScript types
│   └── components/        # React components
├── .env.local             # Environment variables
├── package.json
└── README.md
```

## Next Steps

1. **Connect to Kaspi API**:
   - Get API tokens from Kaspi
   - Update `.env.local` with tokens
   - Create `/api/kaspi/sync-orders` endpoint

2. **Add Production Module**:
   - Create production task pages
   - Implement workshop operations
   - Add production dashboard

3. **Deploy to Vercel**:
   - Push to GitHub
   - Import to Vercel
   - Add environment variables
   - Deploy

## Support

For detailed technical specification, see: `TZ_произ водство_сград.md`
