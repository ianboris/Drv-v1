export async function reserveOrder(sql, orderUid, epoch) {
  const rows = await sql`UPDATE public.ddpe_bot_control
    SET in_flight_order_uid = ${orderUid}, updated_at = NOW()
    WHERE owner_id = 'primary' AND stop_requested = false AND buy_unknown = false
      AND worker_epoch = ${epoch}
      AND (in_flight_order_uid IS NULL OR in_flight_order_uid = ${orderUid})
    RETURNING owner_id`;
  return rows.length === 1;
}
