#!/usr/bin/env bash
# Builds a standalone veraPDF CLI jar from source (pinned tag) via Maven.
#
# ADR-0009 names veraPDF as the required real PDF/UA conformance checker
# for Prompt 6.1's verification letters -- "do not trust the
# `--pdf-standard ua-1` flag existing as sufficient proof". veraPDF has no
# CLI artifact on Maven Central and distributes its GUI installer outside
# GitHub Releases, so the reproducible path is: build the `cli` module
# (which the upstream POM already assembles into a single runnable jar
# via maven-assembly-plugin, main class org.verapdf.apps.GreenfieldCliWrapper)
# from a pinned source tag.
#
# Usage: scripts/verapdf/build.sh
# Output: scripts/verapdf/target/verapdf-cli.jar
#
# Requires: a JDK and Maven on PATH (both already required by nothing
# else in this repo -- CI installs them explicitly, see .github/workflows/ci.yml).
set -euo pipefail

VERAPDF_TAG="v1.31.158"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="${SCRIPT_DIR}/src"
OUT_DIR="${SCRIPT_DIR}/target"
OUT_JAR="${OUT_DIR}/verapdf-cli.jar"

if [[ -f "${OUT_JAR}" ]]; then
  echo "scripts/verapdf/build.sh: ${OUT_JAR} already exists, skipping build"
  exit 0
fi

rm -rf "${WORK_DIR}"
mkdir -p "${WORK_DIR}" "${OUT_DIR}"

echo "scripts/verapdf/build.sh: fetching veraPDF-apps ${VERAPDF_TAG}"
curl -sSL -A "verification-letter-ci" \
  -o "${WORK_DIR}/veraPDF-apps.tar.gz" \
  "https://github.com/veraPDF/veraPDF-apps/archive/refs/tags/${VERAPDF_TAG}.tar.gz"
tar xzf "${WORK_DIR}/veraPDF-apps.tar.gz" -C "${WORK_DIR}"

REPO_DIR="$(find "${WORK_DIR}" -maxdepth 1 -type d -name 'veraPDF-apps-*')"

echo "scripts/verapdf/build.sh: building the 'cli' module (this pulls its own dependency tree from Maven Central)"
( cd "${REPO_DIR}" && mvn -q -pl cli -am -DskipTests package )

# appendAssemblyId=false in cli/pom.xml's assembly-plugin config means the
# shaded, dependency-inclusive jar overwrites the plain jar at this exact
# path -- there is no separate "-jar-with-dependencies" filename to look for.
BUILT_JAR="$(find "${REPO_DIR}/cli/target" -maxdepth 1 -name 'cli-*.jar' | head -n1)"
if [[ -z "${BUILT_JAR}" ]]; then
  echo "scripts/verapdf/build.sh: build succeeded but no cli-*.jar was produced" >&2
  exit 1
fi
cp "${BUILT_JAR}" "${OUT_JAR}"

echo "scripts/verapdf/build.sh: built ${OUT_JAR}"
java -cp "${OUT_JAR}" org.verapdf.apps.GreenfieldCliWrapper --version
