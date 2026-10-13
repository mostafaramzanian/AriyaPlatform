-- Phase 49D-1: Organization Directory minimal attributes (OPTION A).
-- Adds only bounded organization/contact fields to "User". No HR/employment,
-- payroll, attendance, leave, benefits, recruitment or performance data.
-- employeeCode is intentionally DEFERRED.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "department" TEXT,
ADD COLUMN     "extension" TEXT,
ADD COLUMN     "jobTitle" TEXT,
ADD COLUMN     "managerId" TEXT;

-- CreateIndex
CREATE INDEX "User_tenantId_department_idx" ON "User"("tenantId", "department");

-- CreateIndex
CREATE INDEX "User_tenantId_jobTitle_idx" ON "User"("tenantId", "jobTitle");

-- CreateIndex
CREATE INDEX "User_managerId_idx" ON "User"("managerId");

-- AddForeignKey
-- ON DELETE SET NULL: deleting a manager clears the pointer on their reports and
-- never cascades a delete into other User rows.
ALTER TABLE "User" ADD CONSTRAINT "User_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A user can never be their own manager. Prisma cannot express this invariant in
-- the datamodel, so it is enforced in the database as a CHECK constraint.
ALTER TABLE "User" ADD CONSTRAINT "User_manager_not_self" CHECK ("managerId" IS NULL OR "managerId" <> "id");
