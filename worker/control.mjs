export async function claimWorkerLease(sql, epoch, instanceId) {
  const rows = await sql`UPDATE public.ddpe_bot_control
    SET worker_instance_id = ${instanceId},
        worker_lease_expires_at = NOW() + INTERVAL '20 seconds',
        worker_heartbeat_at = NOW(), updated_at = NOW()
    WHERE owner_id = 'primary' AND worker_epoch = ${epoch}
      AND (worker_instance_id IS NULL OR worker_instance_id = ${instanceId}
        OR worker_lease_expires_at IS NULL OR worker_lease_expires_at <= NOW())
      AND (desired_running = true OR in_flight_order_uid IS NOT NULL
        OR (buy_unknown = true AND reconciliation_requested = true))
    RETURNING worker_epoch`;
  return rows.length === 1;
}

export async function releaseWorkerLease(sql, epoch, instanceId) {
  await sql`UPDATE public.ddpe_bot_control
    SET worker_instance_id = NULL, worker_lease_expires_at = NULL, updated_at = NOW()
    WHERE owner_id = 'primary' AND worker_epoch = ${epoch}
      AND worker_instance_id = ${instanceId}`;
}

export async function reserveOrder(sql, orderUid, epoch, instanceId) {
  const rows = await sql`UPDATE public.ddpe_bot_control
    SET in_flight_order_uid = ${orderUid}, updated_at = NOW()
    WHERE owner_id = 'primary' AND stop_requested = false AND buy_unknown = false
      AND worker_epoch = ${epoch} AND worker_instance_id = ${instanceId}
      AND worker_lease_expires_at > NOW()
      AND (in_flight_order_uid IS NULL OR in_flight_order_uid = ${orderUid})
    RETURNING owner_id`;
  return rows.length === 1;
}
