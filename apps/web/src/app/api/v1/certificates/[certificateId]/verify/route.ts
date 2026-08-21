/**
 * GET /api/v1/certificates/:certificateId/verify
 *
 * docs/ddd/training-learning.md's API Contract Sketch: "the public
 * `/api/v1/*` REST surface (e.g. ..., `GET /api/v1/certificates/:id/verify`)
 * is a thin read-oriented wrapper over the same application services."
 * Public, unauthenticated by design — a Certificate's whole purpose is to
 * be a durable, independently verifiable proof of completion a third
 * party (an employer, a partner org) can check without a Volunteer
 * Portal account. Deliberately returns only what a verifier needs to
 * confirm legitimacy — `certificateNumber`, the recipient's already-public
 * `displayName` (`identity`'s `getPersonSummary` OHS read, which
 * "deliberately excludes every field this context treats as sensitive"),
 * the course title, issuance/expiry, and a computed `valid` flag — never
 * the raw `personId`/`courseId`/`enrollmentId` internal identifiers.
 */
import { NextResponse } from "next/server";
import { getCertificate, getCourseById, CertificateNotFoundError, CourseNotFoundError } from "@/modules/training";
import { getPersonSummary } from "@/modules/identity";
import { prisma } from "@/server/db/prisma";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ certificateId: string }> },
) {
  const { certificateId } = await params;

  try {
    const certificate = await getCertificate(prisma, certificateId);
    const [course, recipient] = await Promise.all([
      getCourseById(prisma, certificate.courseId),
      getPersonSummary(prisma, certificate.personId),
    ]);

    const valid = certificate.expiresAt === null || new Date(certificate.expiresAt) > new Date();

    return NextResponse.json({
      valid,
      certificateNumber: certificate.certificateNumber,
      courseTitle: course.title,
      recipientDisplayName: recipient?.displayName ?? null,
      issuedAt: certificate.issuedAt,
      expiresAt: certificate.expiresAt,
    });
  } catch (error) {
    if (error instanceof CertificateNotFoundError || error instanceof CourseNotFoundError) {
      return NextResponse.json({ error: "No such certificate." }, { status: 404 });
    }
    throw error;
  }
}
