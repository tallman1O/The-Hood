# The Hood

A private, self-destructing chat room application built with Next.js. Create secure rooms that automatically expire after 10 minutes, with real-time messaging and automatic message deletion.

## Features

- Private chat rooms with unique room IDs
- Maximum 2 users per room
- Self-destructing rooms with 10-minute time-to-live (TTL)
- Real-time messaging using WebSocket connections
- Automatic message deletion when rooms expire
- Manual room destruction option
- Matrix-style text animations
- Dark theme UI with terminal aesthetic

## Tech Stack

- **Framework**: Next.js 16 with App Router
- **Runtime**: React 19
- **API**: Elysia.js
- **Database**: Upstash Redis
- **Realtime**: Upstash Realtime
- **Styling**: Tailwind CSS 4
- **State Management**: TanStack Query (React Query)
- **Type Safety**: TypeScript
- **Validation**: Zod

## Prerequisites

- Node.js 20 or higher
- Upstash Redis account and credentials
- Upstash Realtime access

## Getting Started

### Installation

Install dependencies using your preferred package manager:

```bash
npm install
# or
yarn install
# or
pnpm install
# or
bun install
```

### Environment Variables

Create a `.env.local` file in the root directory with the following variables:

```env
UPSTASH_REDIS_REST_URL=your_upstash_redis_rest_url
UPSTASH_REDIS_REST_TOKEN=your_upstash_redis_rest_token
```

You can obtain these credentials from your Upstash dashboard.

### Development

Run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser to see the application.

### Building for Production

Build the application:

```bash
npm run build
```

Start the production server:

```bash
npm start
```

## How It Works

1. **Room Creation**: Users create a new room from the lobby page, which generates a unique room ID
2. **Room Access**: Share the room URL with another user. Each room supports a maximum of 2 participants
3. **Authentication**: Users are assigned a unique token stored in HTTP-only cookies
4. **Messaging**: Real-time messages are sent and received via WebSocket connections
5. **Auto-Destruction**: Rooms automatically expire after 10 minutes, deleting all messages
6. **Manual Destruction**: Room creators can manually destroy rooms at any time

## Project Structure

```
src/
├── app/
│   ├── api/
│   │   └── [[...slugs]]/     # Elysia API routes
│   ├── room/
│   │   └── [roomId]/         # Chat room page
│   ├── layout.tsx            # Root layout
│   └── page.tsx              # Lobby/home page
├── components/
│   └── kokonutui/
│       └── matrix-text.tsx   # Matrix animation component
├── hooks/
│   └── use-username.tsx      # Username generation hook
├── lib/
│   ├── client.ts             # Elysia treaty client
│   ├── redis.ts              # Redis client
│   ├── realtime.ts           # Realtime client
│   └── realtime-client.ts    # Realtime React hook
└── proxy.ts                  # Next.js middleware for room access control
```

## API Endpoints

- `POST /api/room/create` - Create a new chat room
- `GET /api/room/ttl` - Get remaining time for a room
- `DELETE /api/room` - Destroy a room
- `POST /api/messages` - Send a message
- `GET /api/messages` - Get all messages in a room
