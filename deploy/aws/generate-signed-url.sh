#!/bin/bash
# Generate pre-signed URL for NISAR file in S3 bucket
# Usage: ./generate-signed-url.sh path/to/file.h5 [expiration_seconds]
#
# Example:
#   ./generate-signed-url.sh L2_GCOV/NISAR_L2_GCOV_001_001_A_001.h5 86400
#
# This generates a URL valid for 24 hours (86400 seconds)

# Configuration - Update these with your bucket details
BUCKET="nisar-oasis"
REGION="us-west-2"

# Parse arguments
KEY="$1"
EXPIRATION="${2:-3600}"  # Default 1 hour (3600 seconds)

if [ -z "$KEY" ]; then
  echo "Usage: $0 <s3-key> [expiration-seconds]"
  echo ""
  echo "Example:"
  echo "  $0 L2_GCOV/NISAR_file.h5 86400"
  echo ""
  echo "Expiration options:"
  echo "  3600    = 1 hour (default)"
  echo "  86400   = 24 hours"
  echo "  604800  = 7 days (max)"
  exit 1
fi

# Check if AWS CLI is installed
if ! command -v aws &> /dev/null; then
  echo "Error: AWS CLI not found. Install with:"
  echo "  curl 'https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip' -o 'awscliv2.zip'"
  echo "  unzip awscliv2.zip"
  echo "  sudo ./aws/install"
  exit 1
fi

# Generate pre-signed URL
echo "Generating signed URL for s3://${BUCKET}/${KEY}"
echo "Expiration: ${EXPIRATION} seconds"
echo ""

URL=$(aws s3 presign "s3://${BUCKET}/${KEY}" \
  --region "${REGION}" \
  --expires-in "${EXPIRATION}" 2>&1)

if [ $? -eq 0 ]; then
  echo "✓ Signed URL generated successfully:"
  echo ""
  echo "${URL}"
  echo ""
  echo "Copy this URL into SARdine to load the file."
else
  echo "✗ Failed to generate signed URL:"
  echo "${URL}"
  exit 1
fi
