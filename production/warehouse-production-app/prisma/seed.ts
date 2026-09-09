import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import bcryptjs from 'bcryptjs';

// .env.local читает только Next; скрипт запускают через tsx, поэтому грузим сами
dotenv.config({ path: '.env.local' });
dotenv.config();

// Заполняет только то, чем владеет само приложение склада: цеха, склады, учётные записи
// сотрудников. Магазины, заказы и позиции заказов НЕ создаются - они приходят из Kaspi
// через синхронизацию соседнего приложения, и выдуманные строки здесь только мешали бы.
// Каталог изделий (warehouse_items) и привязка артикулов тоже уже заполнены из products.

const prisma = new PrismaClient();

const WORKSHOPS = [
  { orderSequence: 1, name: 'Раскрой', description: 'Раскрой материалов' },
  { orderSequence: 2, name: 'Сборка', description: 'Сборка изделий' },
  { orderSequence: 3, name: 'Упаковка', description: 'Упаковка готовых изделий' },
];

const WAREHOUSES = [
  { name: 'Основной склад', location: 'Главное помещение' },
  { name: 'Склад готовой продукции', location: 'Цех 2' },
];

const STAFF = [
  { email: 'admin@artroom.kz', fullName: 'Администратор', role: 'ADMIN' as const },
  { email: 'priemka@artroom.kz', fullName: 'Кладовщик (приёмка)', role: 'WAREHOUSE_RECEIVER' as const },
  { email: 'otgruzka@artroom.kz', fullName: 'Кладовщик (отгрузка)', role: 'WAREHOUSE_SHIPPER' as const },
];

async function main() {
  console.log('Заполняем справочники производства...');

  for (const workshop of WORKSHOPS) {
    await prisma.workshop.upsert({
      where: { orderSequence: workshop.orderSequence },
      update: { name: workshop.name, description: workshop.description },
      create: workshop,
    });
  }
  console.log(`Цеха: ${WORKSHOPS.length}`);

  const warehouses = [];
  for (const warehouse of WAREHOUSES) {
    const existing = await prisma.warehouse.findFirst({ where: { name: warehouse.name } });
    warehouses.push(
      existing ?? (await prisma.warehouse.create({ data: warehouse }))
    );
  }
  console.log(`Склады: ${warehouses.length}`);

  // Пароль одинаковый только для первого запуска - сменить сразу после входа
  const passwordHash = await bcryptjs.hash('warehouse2026', 10);
  for (const person of STAFF) {
    await prisma.productionUser.upsert({
      where: { email: person.email },
      update: { fullName: person.fullName, role: person.role },
      create: {
        ...person,
        passwordHash,
        warehouseId: person.role === 'ADMIN' ? null : warehouses[0].id,
      },
    });
  }
  console.log(`Сотрудники: ${STAFF.length} (пароль по умолчанию warehouse2026 — смените его)`);

  // Изделия, у которых ещё не проставлен склад, относим к основному: без склада
  // приёмка и отгрузка не смогут записать движение.
  const attached = await prisma.warehouseItem.updateMany({
    where: { warehouseId: null },
    data: { warehouseId: warehouses[0].id },
  });
  console.log(`Изделий привязано к основному складу: ${attached.count}`);

  const items = await prisma.warehouseItem.count();
  const links = await prisma.warehouseItemSku.count();
  console.log(`В каталоге ${items} изделий, привязано артикулов Kaspi: ${links}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
