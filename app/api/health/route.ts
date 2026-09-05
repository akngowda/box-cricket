/** Keep-alive target for the daily cron, and a cheap "is it up?" check. */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ ok: true, service: 'box-cricket' });
}
