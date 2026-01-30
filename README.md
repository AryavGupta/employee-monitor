# Employee Monitoring System

A comprehensive desktop monitoring application that captures screenshots every minute and provides an admin dashboard for review and management.

## 🎯 Overview

This system consists of three main components:

1. **Desktop Application** (Electron) - Runs on employee computers, captures screenshots
2. **Backend API** (Node.js/Express) - Handles authentication, screenshot storage, and data management
3. **Admin Dashboard** (React) - Web interface for administrators to view and manage screenshots

## 🏗️ Architecture

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│  Desktop App    │────────>│   Backend API   │<────────│ Admin Dashboard │
│   (Electron)    │         │ (Node.js/Express)│         │     (React)     │
│                 │         │                 │         │                 │
│ - Screenshot    │         │ - Authentication│         │ - View screens  │
│ - Upload every  │         │ - Store images  │         │ - Filter data   │
│   60 seconds    │         │ - User mgmt     │         │ - Flag issues   │
└─────────────────┘         └─────────────────┘         └─────────────────┘
                                     │
                                     │
                            ┌────────▼────────┐
                            │   PostgreSQL    │
                            │    Database     │
                            └─────────────────┘
```

## 🚀 Features

### MVP Features (Current Implementation)
- ✅ Screenshot capture every 60 seconds
- ✅ Secure upload to backend server
- ✅ User authentication (login/logout)
- ✅ Admin dashboard with filtering
- ✅ Filter by employee, date range, time
- ✅ Flag suspicious screenshots
- ✅ Real-time activity tracking
- ✅ User management (activate/deactivate)
- ✅ PostgreSQL database with proper indexes
- ✅ Role-based access control

### Planned Features (Future)
- Activity tracking (apps, mouse/keyboard)
- Idle time detection
- AI-powered summary reports
- Teams management
- Work sessions tracking
- Offline mode support
- Advanced analytics

## 📋 Prerequisites

- **Node.js** v16 or higher
- **PostgreSQL** v12 or higher
- **npm** or **yarn**
- **Windows/Mac/Linux** for desktop app

## 🛠️ Installation & Setup

### 1. Clone the Repository

```bash
git clone <repository-url>
cd employee-monitor
```

### 2. Database Setup

```bash
# Create PostgreSQL database
createdb employee_monitor

# Run schema
psql -d employee_monitor -f backend/database/schema.sql
```

The schema will create:
- Default admin user: `admin@company.com` / `Admin@123`
- All necessary tables with indexes
- Sample teams (Engineering, Sales, Support, Marketing)

### 3. Backend Setup

```bash
# Copy environment file
cp .env.example .env

# Edit .env with your database credentials
nano .env

# Install dependencies
npm install

# Start the backend server
npm run start:backend

# Or for development with auto-reload
npm run dev:backend
```

The backend will run on `http://localhost:3000`

### 4. Admin Dashboard Setup

```bash
# Navigate to dashboard directory
cd admin-dashboard

# Install dependencies
npm install

# Start the React app
npm start
```

The dashboard will open at `http://localhost:3000` (or next available port)

### 5. Desktop App Setup

```bash
# From root directory
# Install dependencies (if not already done)
npm install

# Start desktop app
npm run start:desktop
```

## 🔐 Default Credentials

**Admin Login:**
- Email: `admin@company.com`
- Password: `Admin@123`

## 📁 Project Structure

```
employee-monitor/
├── desktop-app/
│   ├── main.js              # Electron main process
│   ├── login.html           # Login interface
│   └── tracking.html        # Tracking status interface
├── backend/
│   ├── server.js            # Express server
│   ├── routes/
│   │   ├── auth.js          # Authentication routes
│   │   ├── screenshots.js   # Screenshot management
│   │   └── users.js         # User management
│   └── database/
│       └── schema.sql       # Database schema
├── admin-dashboard/
│   ├── src/
│   │   ├── App.js           # Main React app
│   │   ├── components/
│   │   │   ├── Login.js     # Login component
│   │   │   ├── Dashboard.js # Overview dashboard
│   │   │   ├── Screenshots.js # Screenshot viewer
│   │   │   ├── Users.js     # User management
│   │   │   └── Sidebar.js   # Navigation sidebar
│   │   └── App.css          # Global styles
│   └── public/
│       └── index.html
├── package.json
└── .env.example
```

## 🔄 Workflow

### Employee Side (Desktop App)
1. Employee logs in with credentials
2. App starts capturing screenshots every 60 seconds
3. Screenshots are automatically uploaded to server
4. Employee can see tracking status and screenshot count

### Admin Side (Dashboard)
1. Admin logs into web dashboard
2. Views all employee screenshots
3. Filters by employee name, date range, time
4. Can flag suspicious screenshots
5. Manages user accounts (activate/deactivate)

## 🔌 API Endpoints

### Authentication
- `POST /api/auth/login` - User login
- `POST /api/auth/register` - Register new user (admin only)
- `GET /api/auth/verify` - Verify JWT token

### Screenshots
- `POST /api/screenshots/upload` - Upload screenshot
- `GET /api/screenshots` - Get screenshots with filters
- `GET /api/screenshots/:id` - Get single screenshot
- `PATCH /api/screenshots/:id/flag` - Flag/unflag screenshot
- `GET /api/screenshots/stats/summary` - Get statistics

### Users
- `GET /api/users` - Get all users (admin only)
- `GET /api/users/:id` - Get single user
- `PATCH /api/users/:id` - Update user (admin only)
- `DELETE /api/users/:id` - Delete user (admin only)
- `GET /api/users/:id/activity` - Get user activity

## 🗄️ Database Schema

### Key Tables:
- **users** - User accounts with roles
- **teams** - Organizational teams
- **screenshots** - Captured screenshots with metadata
- **activity_logs** - Detailed activity tracking
- **work_sessions** - Work session records
- **alerts** - System alerts
- **audit_logs** - Audit trail

## 🔒 Security Features

- JWT-based authentication
- Bcrypt password hashing (10 rounds)
- Role-based access control (admin, team_manager, employee)
- SQL injection protection (parameterized queries)
- CORS configuration
- Request size limits (50MB for screenshots)
- Audit logging for all admin actions

## 📊 Query Optimization

The system includes several indexes for optimal performance:
- User email index
- Screenshot user_id and timestamp indexes
- Activity log indexes
- Composite indexes for common queries

## 🚢 Deployment

### Backend Deployment (Production)

```bash
# Set environment to production
export NODE_ENV=production

# Use a process manager like PM2
npm install -g pm2
pm2 start backend/server.js --name employee-monitor-api

# Or use Docker
docker build -t employee-monitor-backend .
docker run -p 3000:3000 employee-monitor-backend
```

### Dashboard Deployment

```bash
cd admin-dashboard
npm run build

# Serve the build folder with nginx, apache, or any static host
```

### Desktop App Distribution

```bash
# Build for Windows
npm run build:desktop -- --win

# Build for Mac
npm run build:desktop -- --mac

# Build for Linux
npm run build:desktop -- --linux
```

## 🧪 Testing

```bash
# Backend tests (when implemented)
npm run test:backend

# Frontend tests (when implemented)
cd admin-dashboard
npm test
```

## 🔧 Configuration

### Screenshot Interval
Edit `desktop-app/main.js`:
```javascript
const SCREENSHOT_INTERVAL = 60000; // milliseconds (60000 = 1 minute)
```

### Database Connection
Edit `.env`:
```env
DB_USER=postgres
DB_HOST=localhost
DB_NAME=employee_monitor
DB_PASSWORD=your_password
DB_PORT=5432
```

## 📈 Scaling Considerations

For production deployment:

1. **File Storage**: Move from local filesystem to AWS S3 or similar
2. **Database**: Use connection pooling and read replicas
3. **Load Balancing**: Deploy multiple backend instances
4. **CDN**: Serve static assets through CDN
5. **Caching**: Implement Redis for frequently accessed data
6. **Monitoring**: Add logging (Winston/Bunyan) and monitoring (Datadog/New Relic)

## 🐛 Troubleshooting

### Desktop App Won't Start
- Ensure Node.js is installed
- Check if port 3000 is available
- Verify backend is running

### Screenshots Not Uploading
- Check network connectivity
- Verify API_URL in desktop app configuration
- Check backend logs for errors

### Database Connection Issues
- Verify PostgreSQL is running
- Check credentials in .env file
- Ensure database exists and schema is loaded

## 📝 License

Proprietary - All rights reserved

## 👥 Support

For issues or questions, contact your system administrator.

## 🗺️ Roadmap

**Phase 1 (Current)**: MVP with screenshot capture and viewing
**Phase 2**: Activity tracking and idle detection
**Phase 3**: AI-powered insights and reports
**Phase 4**: Advanced features (offline mode, integrations)

---

Built with ❤️ using Node.js, React, Electron, and PostgreSQL
