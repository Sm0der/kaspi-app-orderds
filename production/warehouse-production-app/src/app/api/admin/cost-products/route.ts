import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { guard } from '@/lib/guard';
import { ApiResponse } from '@/types';

// Поиск кодов технолога (cost_products, SH-4001) для ручной привязки к изделию склада.
// Таблица технолога живёт в базе заказов, у Prisma склада её в схеме нет - сырой запрос,
// как и в admin/skus. Уже занятые коды не исключаем, а показываем, чем заняты: владелец
// связывает вручную и вправе перевесить код на другое изделие сам.
export async function GET(request: NextRequest) {
  const auth = await guard(request, 'admin');
  if (!auth.ok) return auth.response;

  const q = (request.nextUrl.searchParams.get('q') || '').trim();
  const words = q.split(/\s+/).filter(Boolean).slice(0, 6);

  const conditions: string[] = [];
  const params: unknown[] = [];
  for (const word of words) {
    params.push(`%${word}%`);
    conditions.push(`(cp.name ILIKE $${params.length} OR cp.code ILIKE $${params.length})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await prisma.$queryRawUnsafe<{ id: number; code: string | null; name: string }[]>(
    `SELECT cp.id, cp.code, cp.name FROM cost_products cp ${where} ORDER BY cp.code NULLS LAST, cp.name LIMIT 40`,
    ...params
  );

  const ids = rows.map((r) => r.id);
  const usedBy = ids.length
    ? await prisma.warehouseItem.findMany({
        where: { costProductId: { in: ids } },
        select: { id: true, name: true, costProductId: true },
      })
    : [];
  const usedById = new Map(usedBy.map((item) => [item.costProductId, item]));

  return NextResponse.json({
    success: true,
    data: rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      usedByItemId: usedById.get(row.id)?.id ?? null,
      usedByItemName: usedById.get(row.id)?.name ?? null,
    })),
  } as ApiResponse<unknown>);
}

// В таблице технолога часть кодов набрана кириллицей: «КМ-0411» и «ТВ-0208» выглядят
// как латинские KM и TB, но это другие символы - такой код не найдётся поиском по «KM»
// и разберётся в другую категорию. Приводим к латинице молча: человек всё равно имел
// в виду латинскую пару букв, а заметить подмену на глаз невозможно.
const LOOKALIKE: Record<string, string> = {
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X',
};

function normalizeCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[А-Я]/g, (ch) => LOOKALIKE[ch] ?? ch);
}

// POST /api/admin/cost-products - завести код технолога, не выходя из сопоставления.
// Ради цветовых исполнений: у шкафа Лорд их двенадцать (SH-42041...SH-42052), у комода
// Венеция два - себестоимость та же, а код и артикул на складе свои. Поэтому есть
// copyFromId: новый код получает спецификацию, присадку и тарифы исходного изделия,
// иначе маржа по нему считалась бы от пустой спецификации, то есть враньём.
export async function POST(request: NextRequest) {
  const auth = await guard(request, 'admin');
  if (!auth.ok) return auth.response;

  try {
    const body = await request.json();
    const code = normalizeCode(String(body.code || ''));
    const name = String(body.name || '').trim();
    const copyFromId = body.copyFromId ? Number(body.copyFromId) : null;

    const parts = /^([A-Z]{2})-(\d)(\d)(\d{2})(\d?)$/.exec(code);
    if (!parts) {
      return bad('Код в формате SH-4001: две латинские буквы категории, двери, ящики, номер (и цифра исполнения, если оно не одно)');
    }
    if (name.length < 2) return bad('Укажите название изделия');

    const [, category, doors, drawers, serialNo] = parts;

    const created = await prisma.$transaction(async (tx) => {
      const rows = copyFromId
        ? await tx.$queryRaw<{ id: number }[]>`
            INSERT INTO cost_products (code, name, category, doors, drawers, serial_no,
              rate_saw, rate_edge, rate_pack, rate_ship, rate_overhead, drilling_cost,
              margin_divisor, margin_rate, kaspi_markup, updated_at)
            SELECT ${code}, ${name}, ${category}, ${Number(doors)}, ${Number(drawers)}, ${Number(serialNo)},
                   rate_saw, rate_edge, rate_pack, rate_ship, rate_overhead, drilling_cost,
                   margin_divisor, margin_rate, kaspi_markup, NOW()
            FROM cost_products WHERE id = ${copyFromId}
            RETURNING id`
        : await tx.$queryRaw<{ id: number }[]>`
            INSERT INTO cost_products (code, name, category, doors, drawers, serial_no, updated_at)
            VALUES (${code}, ${name}, ${category}, ${Number(doors)}, ${Number(drawers)}, ${Number(serialNo)}, NOW())
            RETURNING id`;

      // source_tab оставляем пустым специально: он связывает изделие с листом Google
      // Таблицы, и импорт технолога по нему решает, что перезаписывать. Заведённый
      // руками код своего листа не имеет и переписываться импортом не должен.
      const newId = rows[0]?.id;
      if (!newId) throw new Error('COPY_SOURCE_NOT_FOUND');

      if (copyFromId) {
        await tx.$executeRaw`
          INSERT INTO cost_product_items (product_id, item_id, quantity, price)
          SELECT ${newId}, item_id, quantity, price FROM cost_product_items WHERE product_id = ${copyFromId}`;
        await tx.$executeRaw`
          INSERT INTO cost_drilling (product_id, confirmats, eccentrics, screws, shelf_holders,
            handles, hinges, groove, parts, area, seconds, load_factor, extra_seconds, pay_per_item, total)
          SELECT ${newId}, confirmats, eccentrics, screws, shelf_holders, handles, hinges, groove,
                 parts, area, seconds, load_factor, extra_seconds, pay_per_item, total
          FROM cost_drilling WHERE product_id = ${copyFromId}`;
      }

      return { id: newId, code, name };
    });

    return NextResponse.json({ success: true, data: created } as ApiResponse<unknown>, { status: 201 });
  } catch (error) {
    const text = error instanceof Error ? error.message : '';
    if (text.includes('23505')) return bad('Такой код уже есть у другого изделия');
    if (text.includes('COPY_SOURCE_NOT_FOUND')) return bad('Изделие, с которого копируем, не найдено');
    console.error('Create cost product error:', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось создать код' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}

function bad(error: string) {
  return NextResponse.json({ success: false, error } as ApiResponse<null>, { status: 400 });
}
