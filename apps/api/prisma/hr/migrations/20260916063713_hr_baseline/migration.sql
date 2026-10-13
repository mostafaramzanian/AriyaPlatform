-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'TERMINATED');

-- CreateEnum
CREATE TYPE "EmploymentType" AS ENUM ('FULL_TIME', 'PART_TIME', 'CONTRACT', 'TEMPORARY', 'INTERNSHIP');

-- CreateEnum
CREATE TYPE "EmploymentStatus" AS ENUM ('ACTIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "HrRecordStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateTable
CREATE TABLE "OrganizationUnit" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "parent_id" UUID,
    "status" "HrRecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "OrganizationUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "organization_unit_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "status" "HrRecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmploymentRecord" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employmentType" "EmploymentType" NOT NULL,
    "status" "EmploymentStatus" NOT NULL DEFAULT 'ACTIVE',
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "organization_unit_id" UUID NOT NULL,
    "position_id" UUID NOT NULL,
    "manager_employee_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "EmploymentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "employee_code" VARCHAR(64) NOT NULL,
    "status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrganizationUnit_tenantId_parentId_code_idx" ON "OrganizationUnit"("tenant_id", "parent_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationUnit_tenantId_code_key" ON "OrganizationUnit"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationUnit_tenantId_id_key" ON "OrganizationUnit"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "Position_tenantId_organizationUnitId_title_idx" ON "Position"("tenant_id", "organization_unit_id", "title");

-- CreateIndex
CREATE UNIQUE INDEX "Position_tenantId_code_key" ON "Position"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Position_tenantId_id_key" ON "Position"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "EmploymentRecord_employeeId_startDate_idx" ON "EmploymentRecord"("employee_id", "start_date");

-- CreateIndex
CREATE INDEX "EmploymentRecord_tenantId_organizationUnitId_startDate_idx" ON "EmploymentRecord"("tenant_id", "organization_unit_id", "start_date");

-- CreateIndex
CREATE INDEX "EmploymentRecord_tenantId_positionId_idx" ON "EmploymentRecord"("tenant_id", "position_id");

-- CreateIndex
CREATE INDEX "EmploymentRecord_managerEmployeeId_idx" ON "EmploymentRecord"("manager_employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "EmploymentRecord_tenantId_id_key" ON "EmploymentRecord"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "Employee_tenantId_status_employeeCode_idx" ON "Employee"("tenant_id", "status", "employee_code");

-- CreateIndex
CREATE INDEX "Employee_tenantId_userId_idx" ON "Employee"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_tenantId_employeeCode_key" ON "Employee"("tenant_id", "employee_code");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_tenantId_id_key" ON "Employee"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "OrganizationUnit" ADD CONSTRAINT "OrganizationUnit_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "OrganizationUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_organization_unit_id_fkey" FOREIGN KEY ("organization_unit_id") REFERENCES "OrganizationUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmploymentRecord" ADD CONSTRAINT "EmploymentRecord_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmploymentRecord" ADD CONSTRAINT "EmploymentRecord_manager_employee_id_fkey" FOREIGN KEY ("manager_employee_id") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmploymentRecord" ADD CONSTRAINT "EmploymentRecord_organization_unit_id_fkey" FOREIGN KEY ("organization_unit_id") REFERENCES "OrganizationUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmploymentRecord" ADD CONSTRAINT "EmploymentRecord_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "Position"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
