import { json, isAdminRequest, unauthorized } from "@/lib/http";
import { computeInsights } from "@/lib/insights";
import { Times } from "@/lib/core";

// GET /api/insights — pay + behavior analytics for the admin.
export async function GET() {
  if (!(await isAdminRequest())) return unauthorized();
  return json(await computeInsights(Times.now()));
}
