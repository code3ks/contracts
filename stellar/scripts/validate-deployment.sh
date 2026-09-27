#!/usr/bin/env bash
# stellar/scripts/validate-deployment.sh
#
# Validates the deployment output from deploy-dryrun.sh to ensure:
# 1. All required contract IDs are present
# 2. Contract IDs are valid Stellar contract addresses
# 3. Contract IDs match the expected network (futurenet)
#
# Usage:
#   ./validate-deployment.sh <output-file> <network>
#
# Arguments:
#   output-file: Path to the deployment output file
#   network: Expected network (e.g., futurenet, testnet, mainnet)
#
# Exit codes:
#   0: All validations passed
#   1: Validation failed

set -euo pipefail

OUTPUT_FILE="${1:?Usage: $0 <output-file> <network>}"
NETWORK="${2:-futurenet}"

# Color helpers
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color
BOLD='\033[1m'

ok()   { printf "  ${GREEN}✓${NC} %s\n" "$*"; }
fail() { printf "  ${RED}✗${NC} %s\n" "$*" >&2; }
info() { printf "  ${BLUE}→${NC} %s\n" "$*"; }
header() { printf "\n${BOLD}═══ %s ═══${NC}\n" "$*"; }

header "Deployment Validation"

# Check if output file exists
if [ ! -f "$OUTPUT_FILE" ]; then
    fail "Output file not found: $OUTPUT_FILE"
    exit 1
fi
ok "Output file found: $OUTPUT_FILE"

# Required contracts
REQUIRED_CONTRACTS=("stealth-announcer" "stealth-registry" "stealth-sender" "wraith-names")
VALIDATION_FAILED=0

# Parse contract IDs from output
declare -A CONTRACT_IDS
info "Parsing contract IDs from output..."

for contract in "${REQUIRED_CONTRACTS[@]}"; do
    # Look for lines like "stealth-announcer CXXXXXXX..."
    # The contract ID appears in the Results section as a table row
    CONTRACT_ID=$(grep -E "^  ${contract}\s+" "$OUTPUT_FILE" | awk '{print $2}' || echo "")
    
    if [ -z "$CONTRACT_ID" ]; then
        fail "Missing contract ID for: $contract"
        VALIDATION_FAILED=1
    else
        CONTRACT_IDS["$contract"]="$CONTRACT_ID"
        info "Found $contract: $CONTRACT_ID"
    fi
done

# Validate contract ID format
# Stellar contract addresses start with 'C' and are 56 characters long (strkey encoded)
header "Contract ID Format Validation"

for contract in "${REQUIRED_CONTRACTS[@]}"; do
    CONTRACT_ID="${CONTRACT_IDS[$contract]:-}"
    
    if [ -z "$CONTRACT_ID" ]; then
        continue  # Already reported as missing above
    fi
    
    # Check if ID starts with 'C'
    if [[ ! "$CONTRACT_ID" =~ ^C ]]; then
        fail "$contract: Invalid format (must start with 'C'): $CONTRACT_ID"
        VALIDATION_FAILED=1
        continue
    fi
    
    # Check if ID is 56 characters long
    if [ "${#CONTRACT_ID}" -ne 56 ]; then
        fail "$contract: Invalid length (must be 56 chars): $CONTRACT_ID (${#CONTRACT_ID} chars)"
        VALIDATION_FAILED=1
        continue
    fi
    
    # Check if ID contains only valid strkey characters (A-Z, 2-7)
    if [[ ! "$CONTRACT_ID" =~ ^C[A-Z2-7]{55}$ ]]; then
        fail "$contract: Invalid characters (must be base32): $CONTRACT_ID"
        VALIDATION_FAILED=1
        continue
    fi
    
    ok "$contract: Valid format"
done

# Validate deployment completed successfully
header "Deployment Status Validation"

if grep -q "All checks passed. Dry-run complete." "$OUTPUT_FILE"; then
    ok "Deployment completed successfully"
elif grep -q "Some smoke tests failed" "$OUTPUT_FILE"; then
    fail "Smoke tests failed during deployment"
    VALIDATION_FAILED=1
else
    fail "Deployment did not complete successfully (missing success marker)"
    VALIDATION_FAILED=1
fi

# Check for deployment errors
if grep -qi "error\|fail\|panic" "$OUTPUT_FILE" | grep -v "may have failed" | grep -v "Some smoke tests failed" | grep -v "failed (may already" | grep -v "registration failed" > /dev/null 2>&1; then
    # Filter out expected errors from re-runs
    ERROR_LINES=$(grep -i "error\|fail\|panic" "$OUTPUT_FILE" | grep -v "may have failed" | grep -v "Some smoke tests failed" | grep -v "failed (may already" | grep -v "registration failed" | head -5 || echo "")
    if [ -n "$ERROR_LINES" ]; then
        fail "Potential errors detected in output:"
        echo "$ERROR_LINES" | while read -r line; do
            echo "    $line"
        done
        info "Review full output for context (some errors may be expected on re-runs)"
    fi
fi

# Network validation (check if stellar.expert URLs match expected network)
header "Network Validation"

EXPERT_URLS=$(grep "stellar.expert/explorer" "$OUTPUT_FILE" || echo "")
if [ -n "$EXPERT_URLS" ]; then
    DETECTED_NETWORK=$(echo "$EXPERT_URLS" | head -1 | grep -o "explorer/[^/]*" | cut -d'/' -f2 || echo "")
    
    if [ "$DETECTED_NETWORK" = "$NETWORK" ]; then
        ok "Network matches expected: $NETWORK"
    elif [ -n "$DETECTED_NETWORK" ]; then
        fail "Network mismatch: expected '$NETWORK', got '$DETECTED_NETWORK'"
        VALIDATION_FAILED=1
    else
        info "Could not detect network from stellar.expert URLs"
    fi
else
    info "No stellar.expert URLs found in output"
fi

# Generate manifest with validated IDs
header "Contract Manifest"

echo ""
MANIFEST_FILE="${OUTPUT_FILE%.txt}-manifest.json"

cat > "$MANIFEST_FILE" <<EOF
{
  "network": "$NETWORK",
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "contracts": {
EOF

FIRST=1
for contract in "${REQUIRED_CONTRACTS[@]}"; do
    CONTRACT_ID="${CONTRACT_IDS[$contract]:-}"
    if [ -n "$CONTRACT_ID" ]; then
        if [ $FIRST -eq 0 ]; then
            echo "," >> "$MANIFEST_FILE"
        fi
        echo -n "    \"$contract\": \"$CONTRACT_ID\"" >> "$MANIFEST_FILE"
        FIRST=0
    fi
done

cat >> "$MANIFEST_FILE" <<EOF

  },
  "validation": {
    "status": "$([ $VALIDATION_FAILED -eq 0 ] && echo "passed" || echo "failed")",
    "required_contracts": ${#REQUIRED_CONTRACTS[@]},
    "found_contracts": ${#CONTRACT_IDS[@]}
  }
}
EOF

ok "Manifest saved to: $MANIFEST_FILE"

# Print summary
header "Validation Summary"

echo ""
printf "  ${BOLD}%-22s %-56s %-10s${NC}\n" "Contract" "Contract ID" "Status"
printf "  ${BOLD}%-22s %-56s %-10s${NC}\n" "───────" "───────────" "──────"

for contract in "${REQUIRED_CONTRACTS[@]}"; do
    CONTRACT_ID="${CONTRACT_IDS[$contract]:-MISSING}"
    if [ "$CONTRACT_ID" = "MISSING" ]; then
        STATUS="${RED}✗ MISSING${NC}"
    else
        STATUS="${GREEN}✓ VALID${NC}"
    fi
    printf "  %-22s %-56s " "$contract" "$CONTRACT_ID"
    printf "${STATUS}\n"
done

echo ""

if [ $VALIDATION_FAILED -ne 0 ]; then
    fail "Validation FAILED - deployment output contains errors or missing contract IDs"
    exit 1
fi

ok "All validations PASSED"
echo ""
exit 0
