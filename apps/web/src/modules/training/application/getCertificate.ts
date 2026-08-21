import type { PrismaClient } from "@prisma/client";
import { CertificateNotFoundError } from "../domain/errors";

export interface CertificateDTO {
  certificateId: string;
  personId: string;
  courseId: string;
  enrollmentId: string;
  certificateNumber: string;
  pdfFileKey: string | null;
  templateVersion: string;
  issuedAt: string;
  expiresAt: string | null;
}

function toDto(certificate: {
  id: string;
  personId: string;
  courseId: string;
  enrollmentId: string;
  certificateNumber: string;
  pdfFileKey: string | null;
  templateVersion: string;
  issuedAt: Date;
  expiresAt: Date | null;
}): CertificateDTO {
  return {
    certificateId: certificate.id,
    personId: certificate.personId,
    courseId: certificate.courseId,
    enrollmentId: certificate.enrollmentId,
    certificateNumber: certificate.certificateNumber,
    pdfFileKey: certificate.pdfFileKey,
    templateVersion: certificate.templateVersion,
    issuedAt: certificate.issuedAt.toISOString(),
    expiresAt: certificate.expiresAt ? certificate.expiresAt.toISOString() : null,
  };
}

/** GetCertificate (API Contract Sketch: `getCertificate({ certificateId }) -> CertificateDTO`). */
export async function getCertificate(prisma: PrismaClient, certificateId: string): Promise<CertificateDTO> {
  const certificate = await prisma.certificate.findUnique({ where: { id: certificateId } });
  if (!certificate) {
    throw new CertificateNotFoundError(certificateId);
  }
  return toDto(certificate);
}

/** Every Certificate a Person holds — the profile/portfolio-display read Community (later phase) consumes. */
export async function listCertificatesForPerson(prisma: PrismaClient, personId: string): Promise<CertificateDTO[]> {
  const certificates = await prisma.certificate.findMany({
    where: { personId },
    orderBy: { issuedAt: "desc" },
  });
  return certificates.map(toDto);
}
