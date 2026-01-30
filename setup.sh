#!/bin/bash

# Employee Monitoring System - Quick Setup Script
# This script helps you set up the entire system quickly

set -e

echo "=================================="
echo "Employee Monitoring System Setup"
echo "=================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is not installed${NC}"
    echo "Please install Node.js v16 or higher from https://nodejs.org/"
    exit 1
fi

echo -e "${GREEN}✓ Node.js found: $(node --version)${NC}"

# Check if PostgreSQL is installed
if ! command -v psql &> /dev/null; then
    echo -e "${YELLOW}Warning: PostgreSQL command line tools not found${NC}"
    echo "Make sure PostgreSQL is installed and running"
fi

echo ""
echo "Step 1: Installing dependencies..."
npm install

echo ""
echo "Step 2: Setting up environment..."
if [ ! -f .env ]; then
    cp .env.example .env
    echo -e "${GREEN}✓ Created .env file${NC}"
    echo -e "${YELLOW}Please edit .env with your database credentials${NC}"
else
    echo -e "${YELLOW}✓ .env file already exists${NC}"
fi

echo ""
echo "Step 3: Database setup..."
read -p "Have you created the database and run the schema? (y/n) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${GREEN}✓ Database setup confirmed${NC}"
else
    echo ""
    echo "Please run the following commands:"
    echo "  createdb employee_monitor"
    echo "  psql -d employee_monitor -f backend/database/schema.sql"
    echo ""
    read -p "Press enter to continue when done..."
fi

echo ""
echo "Step 4: Installing dashboard dependencies..."
cd admin-dashboard
npm install
cd ..

echo ""
echo -e "${GREEN}=================================="
echo "Setup Complete!"
echo "==================================${NC}"
echo ""
echo "To start the system:"
echo ""
echo "1. Start Backend Server:"
echo "   npm run start:backend"
echo ""
echo "2. Start Admin Dashboard (in new terminal):"
echo "   cd admin-dashboard && npm start"
echo ""
echo "3. Start Desktop App (in new terminal):"
echo "   npm run start:desktop"
echo ""
echo "Default admin credentials:"
echo "  Email: admin@company.com"
echo "  Password: Admin@123"
echo ""
echo -e "${YELLOW}Don't forget to change the default password!${NC}"
echo ""
