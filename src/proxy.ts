import { NextRequest, NextResponse } from "next/server";
import { redis } from "./lib/redis";
import { nanoid } from "nanoid";

export const proxy = async (request: NextRequest) => {
    const pathname = request.nextUrl.pathname

    const roomMatch = pathname.match(/^\/room\/([^/]+)$/)
    if (!roomMatch) return NextResponse.redirect(new URL("/", request.url))

    const roomId = roomMatch[1]

    const meta = await redis.hgetall<{connected: string[], createdAt: number}>(`meta:${roomId}`)
    if (!meta) return NextResponse.redirect(new URL("/?error=room-not-found", request.url))

    const existingToken = request.cookies.get("x-auth-token")?.value
    if (existingToken && meta.connected.includes(existingToken)) {
        return NextResponse.next()
    }

    if (meta.connected.length >= 2) {
        return NextResponse.redirect(new URL("/?error=room-full", request.url))
    }

    const response = NextResponse.next()
    const token = nanoid()
    response.cookies.set("x-auth-token", token, {
        path: "/",
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
    })

    await redis.hset(`meta:${roomId}`, {
        connected: [...meta.connected, token],
    })

    return response
}

export const config = {
    matcher: "/room/:path*",
}