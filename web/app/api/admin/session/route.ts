import { json, isAdminRequest } from "@/lib/http";

// GET /api/admin/session — whether the admin PIN cookie is present/valid.
export async function GET() {
  return json({ admin: await isAdminRequest() });
}
