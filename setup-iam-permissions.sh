#!/bin/bash
# Setup IAM permissions for nisar-oasis bucket
#
# This script helps you attach the necessary permissions to your IAM user or role.
# You need IAM permission management rights to run this (or ask your AWS admin).

set -e

echo "=== NISAR Oasis IAM Permission Setup ==="
echo ""

# Get current IAM identity
echo "Step 1: Checking your AWS identity..."
IDENTITY=$(aws sts get-caller-identity --output json 2>/dev/null)

if [ $? -ne 0 ]; then
  echo "❌ Error: Cannot get AWS identity. Is AWS CLI configured?"
  echo "   Run: aws configure"
  exit 1
fi

echo "✓ AWS CLI is configured"
echo ""

# Extract user/role info
USER_ARN=$(echo "$IDENTITY" | jq -r '.Arn')
ACCOUNT_ID=$(echo "$IDENTITY" | jq -r '.Account')
echo "Your IAM Identity: $USER_ARN"
echo "Account ID: $ACCOUNT_ID"
echo ""

# Determine if user or role
if [[ "$USER_ARN" == *":user/"* ]]; then
  ENTITY_TYPE="user"
  IAM_USER=$(echo "$USER_ARN" | awk -F'/' '{print $NF}')
  echo "Entity Type: IAM User"
  echo "Username: $IAM_USER"
elif [[ "$USER_ARN" == *":assumed-role/"* ]]; then
  ENTITY_TYPE="role"
  ROLE_NAME=$(echo "$USER_ARN" | awk -F'/' '{print $(NF-1)}')
  echo "Entity Type: IAM Role"
  echo "Role Name: $ROLE_NAME"
else
  echo "❌ Error: Unknown IAM entity type"
  exit 1
fi
echo ""

# Policy name
POLICY_NAME="NISAROasisBucketAccess"

# Check if policy already exists
echo "Step 2: Checking if policy exists..."
EXISTING_POLICY=$(aws iam list-policies --scope Local --query "Policies[?PolicyName=='$POLICY_NAME'].Arn" --output text 2>/dev/null)

if [ -n "$EXISTING_POLICY" ]; then
  echo "✓ Policy already exists: $EXISTING_POLICY"
  POLICY_ARN="$EXISTING_POLICY"
else
  echo "Creating new policy: $POLICY_NAME..."

  # Create the policy
  POLICY_ARN=$(aws iam create-policy \
    --policy-name "$POLICY_NAME" \
    --policy-document file://iam-policy-nisar-oasis.json \
    --description "Permissions for nisar-oasis S3 bucket operations" \
    --query 'Policy.Arn' \
    --output text 2>&1)

  if [ $? -eq 0 ]; then
    echo "✓ Policy created: $POLICY_ARN"
  else
    echo "❌ Error creating policy:"
    echo "$POLICY_ARN"
    echo ""
    echo "You may not have IAM policy creation permissions."
    echo "Ask your AWS administrator to create this policy and attach it to your user/role."
    exit 1
  fi
fi
echo ""

# Attach policy
echo "Step 3: Attaching policy to your IAM entity..."

if [ "$ENTITY_TYPE" == "user" ]; then
  # Attach to user
  aws iam attach-user-policy \
    --user-name "$IAM_USER" \
    --policy-arn "$POLICY_ARN" 2>&1

  if [ $? -eq 0 ]; then
    echo "✓ Policy attached to user: $IAM_USER"
  else
    echo "❌ Error attaching policy to user"
    echo "You may not have permission to modify user policies."
    echo "Ask your AWS administrator to run:"
    echo "  aws iam attach-user-policy --user-name $IAM_USER --policy-arn $POLICY_ARN"
    exit 1
  fi

elif [ "$ENTITY_TYPE" == "role" ]; then
  # Attach to role
  aws iam attach-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-arn "$POLICY_ARN" 2>&1

  if [ $? -eq 0 ]; then
    echo "✓ Policy attached to role: $ROLE_NAME"
  else
    echo "❌ Error attaching policy to role"
    echo "Ask your AWS administrator to run:"
    echo "  aws iam attach-role-policy --role-name $ROLE_NAME --policy-arn $POLICY_ARN"
    exit 1
  fi
fi
echo ""

# Test permissions
echo "Step 4: Testing bucket access..."
aws s3 ls s3://nisar-oasis/ >/dev/null 2>&1

if [ $? -eq 0 ]; then
  echo "✓ Bucket access confirmed!"
else
  echo "⚠️  Cannot access bucket yet (permissions may take a few seconds to propagate)"
  echo "   Try again in 10-30 seconds"
fi
echo ""

echo "=== Setup Complete ==="
echo ""
echo "You can now run:"
echo "  aws s3api put-bucket-versioning --bucket nisar-oasis --versioning-configuration Status=Enabled"
echo "  aws s3api put-bucket-cors --bucket nisar-oasis --cors-configuration file://cors-config.json"
echo "  aws s3 cp file.h5 s3://nisar-oasis/L2_GCOV/"
echo ""
