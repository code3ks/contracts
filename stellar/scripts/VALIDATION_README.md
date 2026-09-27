# Stellar Deployment Validation

## Overview

This directory contains scripts for validating Stellar contract deployments to ensure they complete successfully and produce valid contract IDs.

## Scripts

### `deploy-dryrun.sh`
The main deployment script that deploys all Wraith Protocol Stellar contracts to futurenet and runs smoke tests.

### `validate-deployment.sh`
Validation script that ensures deployment output meets requirements:
- All required contract IDs are present (stealth-announcer, stealth-registry, stealth-sender, wraith-names)
- Contract IDs are valid Stellar addresses (start with 'C', 56 characters, valid base32)
- Contract IDs match the expected network
- Deployment completed successfully
- Generates a JSON manifest with validated contract IDs

**Usage:**
```bash
./validate-deployment.sh <output-file> <network>
```

**Example:**
```bash
./validate-deployment.sh deploy-dryrun-output.txt futurenet
```

**Exit Codes:**
- 0: All validations passed
- 1: Validation failed

**Outputs:**
- `<output-file>-manifest.json`: JSON manifest with validated contract IDs and validation status

### `validate-deployment.test.sh`
Unit tests for the validation script covering:
- Valid deployment output
- Missing contract IDs
- Invalid contract ID formats
- Wrong network detection
- Smoke test failures

**Usage:**
```bash
./validate-deployment.test.sh
```

## CI Integration

The validation is integrated into the `.github/workflows/ci.yml` workflow in the `stellar-deploy-dryrun` job:

1. **Removed `continue-on-error: true`** - Job now fails on errors
2. **Removed `|| true` from parsing** - Parsing failures now fail the job
3. **Added exit code checking** - Deploy script failures are caught and reported
4. **Added validation step** - Runs `validate-deployment.sh` to verify output
5. **Added contract count verification** - Ensures all 4 contracts are present
6. **Added manifest artifact** - Uploads JSON manifest with validated IDs

## Validation Requirements

### Contract ID Format
- Must start with 'C'
- Must be exactly 56 characters long
- Must contain only valid base32 characters (A-Z, 2-7)

### Required Contracts
1. stealth-announcer
2. stealth-registry
3. stealth-sender
4. wraith-names

### Network Validation
Contract IDs are verified against the expected network by checking stellar.expert URLs in the output.

## Artifacts

The following artifacts are uploaded on every run (success or failure):
- `deploy-dryrun-output.txt` - Full deployment output
- `deploy-dryrun-output-manifest.json` - JSON manifest with validated IDs
- `contract-ids.txt` - Parsed contract IDs (legacy format)

## Example Manifest

```json
{
  "network": "futurenet",
  "timestamp": "2026-09-27T12:34:56Z",
  "contracts": {
    "stealth-announcer": "CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRS",
    "stealth-registry": "CBCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRST",
    "stealth-sender": "CCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTU",
    "wraith-names": "CDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV"
  },
  "validation": {
    "status": "passed",
    "required_contracts": 4,
    "found_contracts": 4
  }
}
```

## Troubleshooting

### Validation Fails with "Missing contract ID"
Check the deployment output to ensure the contract was deployed successfully. Look for error messages in the deploy step.

### Validation Fails with "Invalid format"
The contract ID doesn't match Stellar's address format. This usually indicates a parsing error or corrupted output.

### Validation Fails with "Network mismatch"
The deployment was made to a different network than expected. Verify the `RPC_URL` and `NETWORK` environment variables.

### Smoke tests failed
Check the deployment output for specific test failures. Common causes:
- Network connectivity issues
- Insufficient account balance
- Contract initialization errors
