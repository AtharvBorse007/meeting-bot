# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial project setup
- Multi-platform meeting bot support (Google Meet, Microsoft Teams, Zoom)
- RESTful API endpoints for meeting management
- Docker containerization support
- Graceful shutdown handling
- Prometheus metrics integration
- Stealth mode browser automation
- Single job execution system
- Recording functionality with duration limits
- Lecture Recorder: admin and instructor accounts, subjects with one YouTube playlist each, and a
  dashboard (`ui/`) where instructors start (Join & record) and end (End & save) lecture recordings
- Several lectures recorded at the same time (`MAX_CONCURRENT_BOTS`, default 3); further requests
  are refused with a clear message instead of queued
- Automatic YouTube upload (unlisted by default) with resumable transfers, retries and playlist
  placement; recordings wait on the server while YouTube is not connected
- SQLite database (Node's built-in `node:sqlite`) for accounts, subjects and lecture history;
  recordings in progress during a server restart are saved and uploaded afterwards
- Lecture recording rules: no silence cut-off, leave after 10 minutes alone, 5-hour limit, VP8 at
  800 kbps / 15 fps, uploads skipped for recordings under a minute
- Server copies of recordings are deleted 14 days after they are on YouTube, earlier when disk space
  runs low
- Deployment for a single server: `Dockerfile` (amd64 and arm64), `deploy/` with Docker Compose,
  Caddy (automatic HTTPS), install / update / backup / restore / reset-password scripts, and `docs/SETUP.md`
- Deployment on AWS, Google Cloud, Azure or Oracle: `deploy/cloud-init.sh` installs a new VM
  unattended from the start-up script field, and `docs/CLOUD.md` has console steps and CLI commands for each
- Pay-per-use recording on AWS (`RECORDER_MODE=ecs`): the dashboard starts one Fargate task per
  lecture; recorders stream 30-second segments to S3 and report every 5 s; lost, hung or reclaimed
  recorders are replaced automatically (with a hand-over on AWS notice), and the parts are joined
  into one video. Survives dashboard restarts.
- AWS: CloudFormation template (`deploy/aws/lecture-recorder.yaml`) creating the EC2 server
  (Graviton by default), Elastic IP, encrypted S3 backup bucket, IAM role, Session Manager access,
  recovery/reboot alarms and a cost budget; `docs/AWS.md`
- Every saved recording is copied to S3 and the database is backed up there daily; server copies
  are only removed once a recording is on YouTube and in S3; downloads fall back to signed S3 links;
  `deploy/restore-from-s3.sh` restores the database from the bucket
- The YouTube OAuth client can be entered in the dashboard (Settings) instead of on the server
- Development tools: `scripts/dev/dev-server.js` (fake Google Meet and YouTube) and
  `scripts/dev/e2e.js` (end-to-end test)

### Changed
- The server listens on `127.0.0.1` unless `HOST` is set (the image sets `HOST=0.0.0.0` behind Caddy)
- The original unauthenticated `/google`, `/microsoft`, `/zoom`, `/status`, `/isbusy` and
  `/metrics` routes are off unless `LEGACY_API_ENABLED=true`
- Microsoft Teams jobs run exclusively (they share one ffmpeg display/audio device)
- A bot browser that closes unexpectedly ends the recording immediately and keeps the partial file
- Node.js 22.13 or newer is required

### Deprecated
- N/A

### Removed
- N/A

### Fixed
- N/A

### Security
- N/A

## [1.0.0] - 2024-01-01

### Added
- Initial release of Meeting Bot
- Support for Google Meet automation
- Support for Microsoft Teams automation  
- Support for Zoom automation
- Express.js web server with RESTful API
- Playwright-based browser automation
- Job store for single execution management
- Recording task implementation
- Docker and Docker Compose configuration
- TypeScript implementation with strict typing
- Winston logging integration
- Environment-based configuration
- Graceful shutdown handling
- Prometheus metrics endpoint
- Comprehensive error handling
- Middleware for file uploads
- Authentication utilities
- String and recording name utilities
- Resilience and retry mechanisms

### Technical Details
- Built with Node.js and TypeScript
- Uses Playwright for browser automation
- Express.js for web server functionality
- Docker for containerization
- ESLint for code quality
- Comprehensive type definitions

---

## Version History

- **1.0.0** - Initial release with core functionality
- **Unreleased** - Development version with ongoing improvements

## Release Notes

### Version 1.0.0
This is the initial release of Meeting Bot, providing a solid foundation for automated meeting management across multiple platforms. The release includes:

- Complete API for joining meetings on Google Meet, Microsoft Teams, and Zoom
- Robust browser automation with anti-detection measures
- Containerized deployment with Docker
- Comprehensive error handling and logging
- Single job execution system to prevent conflicts
- Recording capabilities with configurable duration limits

### Future Releases
Planned features for upcoming releases include:

- Additional meeting platform support
- Enhanced monitoring and analytics
- Improved stealth capabilities
- Advanced recording options
- Webhook integrations
- User management and authentication
- API rate limiting and quotas

---

## Contributing to the Changelog

When contributing to this project, please update the changelog by adding entries under the `[Unreleased]` section following the format above. When a new version is released, move the unreleased changes to the new version section.

### Changelog Entry Types

- **Added** for new features
- **Changed** for changes in existing functionality
- **Deprecated** for soon-to-be removed features
- **Removed** for now removed features
- **Fixed** for any bug fixes
- **Security** for security vulnerability fixes 