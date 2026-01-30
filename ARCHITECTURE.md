# Technical Architecture Document

## System Overview

The Employee Monitoring System is a full-stack application designed to track employee activity through automated screenshot capture and provide administrators with tools to review and analyze this data.

## Technology Stack

### Desktop Application
- **Framework**: Electron 27.x
- **Language**: JavaScript (Node.js)
- **Key Libraries**:
  - `desktopCapturer`: Screen capture API
  - `axios`: HTTP client for API communication
  - `electron-builder`: Application packaging

### Backend API
- **Runtime**: Node.js 16+
- **Framework**: Express.js 4.x
- **Database**: PostgreSQL 12+
- **Key Libraries**:
  - `pg`: PostgreSQL client
  - `bcrypt`: Password hashing
  - `jsonwebtoken`: JWT authentication
  - `cors`: Cross-origin resource sharing
  - `multer`: File upload handling

### Admin Dashboard
- **Framework**: React 18.x
- **Routing**: React Router v6
- **HTTP Client**: Axios
- **Date Handling**: date-fns
- **Styling**: Custom CSS (no framework dependencies)

## System Architecture

### High-Level Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Internet/Network                       │
└──────────────────────────────────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
        ▼                    ▼                    ▼
┌───────────────┐    ┌──────────────┐    ┌──────────────┐
│  Desktop App  │    │  Backend API │    │   Dashboard  │
│  (Electron)   │────│  (Node.js)   │────│   (React)    │
└───────────────┘    └──────────────┘    └──────────────┘
        │                    │                    
        │            ┌───────▼────────┐           
        └───────────▶│   PostgreSQL   │           
                     │    Database    │           
                     └────────────────┘           
                             │
                     ┌───────▼────────┐
                     │  File Storage  │
                     │  (Screenshots) │
                     └────────────────┘
```

## Component Details

### 1. Desktop Application (Electron)

#### Responsibilities:
- User authentication
- Automated screenshot capture
- Image upload to backend
- Session management
- Local activity tracking

#### Key Features:
- **Screenshot Capture**: Uses Electron's `desktopCapturer` API
- **Upload Mechanism**: Base64 encoding → HTTP POST
- **Frequency**: Configurable interval (default: 60 seconds)
- **Authentication**: JWT token storage
- **Network Resilience**: Error handling for failed uploads

#### Process Flow:
```
1. User Login → JWT Token Received
2. Start Monitoring Loop
3. Every 60s:
   - Capture screenshot
   - Convert to base64
   - POST to /api/screenshots/upload
   - Update local UI
4. Continue until logout/close
```

#### Security Considerations:
- Tokens stored in memory only
- No sensitive data cached locally
- Secure HTTPS communication
- Automatic session timeout

### 2. Backend API (Express/Node.js)

#### Architecture Pattern: MVC with Route-Based Organization

```
backend/
├── server.js           # Application entry point
├── routes/             # Route handlers
│   ├── auth.js        # Authentication endpoints
│   ├── screenshots.js # Screenshot management
│   └── users.js       # User management
└── database/
    └── schema.sql     # Database schema
```

#### API Endpoints:

**Authentication (`/api/auth`)**:
- `POST /login` - User authentication
- `POST /register` - New user registration
- `GET /verify` - Token verification

**Screenshots (`/api/screenshots`)**:
- `POST /upload` - Upload screenshot
- `GET /` - List screenshots (with filters)
- `GET /:id` - Get specific screenshot
- `PATCH /:id/flag` - Flag/unflag screenshot
- `GET /stats/summary` - Get statistics

**Users (`/api/users`)**:
- `GET /` - List all users (admin only)
- `GET /:id` - Get user details
- `PATCH /:id` - Update user
- `DELETE /:id` - Delete user
- `GET /:id/activity` - Get user activity

#### Middleware Stack:
```
Request → CORS → Body Parser → Routes → Auth Middleware → Controller → Response
```

#### Authentication Flow:
```
1. User submits credentials
2. Server validates against database
3. bcrypt verifies password hash
4. JWT token generated and returned
5. Client includes token in Authorization header
6. Server validates token on protected routes
```

#### File Storage Strategy:
- **Current**: Local filesystem (`/uploads/screenshots/`)
- **Naming**: `{userId}_{timestamp}.png`
- **Future**: AWS S3 or similar object storage

### 3. Admin Dashboard (React)

#### Component Hierarchy:
```
App
├── Login
└── Authenticated Layout
    ├── Sidebar (navigation)
    ├── Dashboard (overview)
    ├── Screenshots (main feature)
    └── Users (admin only)
```

#### State Management:
- **Authentication**: localStorage + React Context
- **Data Fetching**: Axios with async/await
- **Local State**: useState hooks
- **No Redux**: Simple enough for local state

#### Routing:
```
/login         → Login component
/dashboard     → Dashboard overview
/screenshots   → Screenshot gallery with filters
/users         → User management (admin only)
```

#### Key Features:
- Real-time filtering (client-side)
- Pagination support
- Modal screenshot viewer
- Responsive grid layout
- Role-based rendering

### 4. Database (PostgreSQL)

#### Schema Design Philosophy:
- Normalized structure
- Proper foreign key constraints
- Comprehensive indexing
- Audit trail for all actions
- Scalability considerations

#### Key Tables:

**users**:
```sql
- id (UUID, PK)
- email (unique, indexed)
- password_hash
- full_name
- role (admin/team_manager/employee)
- team_id (FK)
- is_active
- timestamps
```

**screenshots**:
```sql
- id (UUID, PK)
- user_id (FK, indexed)
- screenshot_url
- captured_at (indexed)
- file_size
- system_info (JSONB)
- is_flagged (indexed)
- flag_reason
```

**work_sessions**:
```sql
- id (UUID, PK)
- user_id (FK)
- session_start
- session_end
- total_active_time
- total_idle_time
- screenshot_count
```

#### Indexes:
- Single-column indexes on frequently queried fields
- Composite indexes for common filter combinations
- Partial indexes for boolean flags

#### Views:
- `user_activity_summary`: Aggregated user metrics
- `daily_activity`: Daily breakdown per user

## Data Flow

### Screenshot Upload Flow:
```
1. Desktop App captures screen
2. Convert to base64 string
3. POST to /api/screenshots/upload with:
   - screenshot data
   - timestamp
   - system info
4. Backend receives request
5. Validates JWT token
6. Decodes base64 to buffer
7. Saves file to disk
8. Inserts metadata to database
9. Returns success response
10. Desktop app updates UI
```

### Screenshot Retrieval Flow:
```
1. Admin opens dashboard
2. Applies filters (user, date, status)
3. Frontend sends GET request with query params
4. Backend constructs SQL query
5. Joins users and teams tables
6. Applies filters and pagination
7. Returns JSON array of screenshots
8. Frontend renders grid
9. Admin clicks thumbnail
10. Modal displays full image
```

## Security Architecture

### Authentication & Authorization:
- **Password Storage**: bcrypt with 10 salt rounds
- **Session Management**: JWT tokens (24h expiry)
- **Role-Based Access Control**: Middleware checks user role
- **API Protection**: All routes require valid JWT

### Data Security:
- **In Transit**: HTTPS (production)
- **At Rest**: Database encryption (configurable)
- **File Access**: Direct filesystem access (consider S3 with signed URLs)

### Attack Prevention:
- **SQL Injection**: Parameterized queries
- **XSS**: React auto-escapes content
- **CSRF**: SameSite cookies + CORS
- **Rate Limiting**: Can be added with express-rate-limit

## Performance Considerations

### Database Optimization:
- Connection pooling (pg Pool)
- Indexes on frequently queried columns
- Periodic VACUUM operations
- Read replicas for scaling

### File Storage:
- Current: Local filesystem
- Limitation: Single server, no CDN
- Future: Object storage (S3) with CloudFront CDN

### API Performance:
- Response compression (gzip)
- Pagination for large datasets
- Efficient SQL queries
- Caching strategy (Redis for future)

### Frontend Optimization:
- Code splitting (React.lazy)
- Image lazy loading
- Efficient re-renders (React.memo)
- Bundle optimization (tree shaking)

## Scalability Strategy

### Current Architecture:
- Monolithic backend
- Single database
- Local file storage
- Suitable for: <1000 employees

### Scaling Path:

**Phase 1** (1K-5K users):
- Load balancer
- Multiple API instances
- Database connection pooling
- S3 for file storage

**Phase 2** (5K-20K users):
- Microservices architecture
- Separate screenshot service
- Redis caching layer
- Database read replicas
- CDN for static assets

**Phase 3** (20K+ users):
- Kubernetes orchestration
- Horizontal auto-scaling
- Database sharding
- Message queue (RabbitMQ/Kafka)
- Distributed caching

## Monitoring & Logging

### Application Monitoring:
- Health check endpoint (`/health`)
- PM2 process monitoring
- Error logging (Winston)
- Performance metrics

### Database Monitoring:
- Query performance
- Connection pool stats
- Slow query log
- Database size metrics

### User Activity:
- Audit logs table
- Admin action tracking
- Login attempts
- Failed upload tracking

## Deployment Architecture

### Development:
```
Local Machine → localhost:3000 (all services)
```

### Production Options:

**Option 1: Traditional VPS**:
```
Nginx → Node.js (PM2) → PostgreSQL
      → Static Files (React build)
```

**Option 2: Cloud Native**:
```
Load Balancer → ECS/EKS containers
              → RDS PostgreSQL
              → S3 for files
              → CloudFront CDN
```

## Future Enhancements

### Planned Features:
1. Real-time activity monitoring
2. AI-powered productivity analysis
3. Idle time detection
4. Application usage tracking
5. Offline mode support
6. Mobile admin app
7. Advanced reporting
8. Integration APIs

### Technical Improvements:
1. WebSocket for real-time updates
2. GraphQL API option
3. Microservices migration
4. Event sourcing for audit trail
5. Machine learning models
6. Advanced caching strategy
7. Multi-tenancy support

## Maintenance & Support

### Regular Tasks:
- Database backups (daily)
- Log rotation (weekly)
- Security updates (as needed)
- Performance optimization (monthly)
- Data cleanup (configurable)

### Backup Strategy:
- Database: pg_dump daily
- Files: Sync to backup storage
- Retention: 30 days
- Recovery testing: Monthly

## Conclusion

This architecture provides a solid foundation for an employee monitoring system with room for growth. The modular design allows for incremental improvements and scaling as requirements evolve.

---

Version: 1.0.0
Last Updated: 2025-01-09
