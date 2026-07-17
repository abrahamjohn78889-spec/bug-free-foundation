import { Suspense } from "react"
import { LoginForm } from "@/components/login-form"

export const metadata = { title: "Login — BTC 5M Terminal" }

export default function LoginPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-6">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  )
}
