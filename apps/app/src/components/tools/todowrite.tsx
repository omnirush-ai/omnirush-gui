"use client"

import { Circle, CircleCheck, CircleDot, CircleX } from "lucide-react"
import { Tool } from "@/components/ui/tool"
import type { TodoWriteToolPart } from "@/lib/build-in-tools"
import { cn } from "@/lib/utils"

interface TodoWriteToolProps {
  part: TodoWriteToolPart
}

function getTodoWriteToolTitle(part: TodoWriteToolPart): string | null {
  // Streamed/interrupted tool calls can surface with partial input despite
  // the type contract; an unguarded read here white-screened the whole app.
  const count = part.input?.todos?.length ?? 0

  if (part.state === "output-error") {
    return "Update todo list attempted"
  }

  if (part.state !== "output-available") {
    return null
  }

  return count > 0 ? `Update todo list (${count})` : "Update todo list"
}

const PENDING = { Icon: Circle, label: "To do", className: "text-muted-foreground" }

const TODO_STATUS = new Map([
  ["pending", PENDING],
  ["in_progress", { Icon: CircleDot, label: "In progress", className: "text-blue-11" }],
  ["completed", { Icon: CircleCheck, label: "Done", className: "text-green-11" }],
  ["cancelled", { Icon: CircleX, label: "Cancelled", className: "text-muted-foreground" }],
])

export function TodoWriteTool({ part }: TodoWriteToolProps) {
  // Same partial-input guard as the title: a streamed part may lack todos.
  const listed = part.input?.todos
  const todos = Array.isArray(listed) ? listed : []
  return (
    <Tool toolPart={part} title={getTodoWriteToolTitle(part) ?? undefined}>
      {todos.length > 0 ? (
        <ul className="flex flex-col gap-1 pr-8" data-testid="todo-checklist">
          {todos.map((todo, index) => {
            const { Icon, label, className } = TODO_STATUS.get(todo.status) ?? PENDING
            return (
              <li key={`${index}:${todo.content}`} className="flex items-start gap-2" data-status={todo.status}>
                <Icon className={cn("mt-px size-3.5 shrink-0", className)} aria-label={label} />
                <span
                  className={cn(
                    "min-w-0 wrap-break-word",
                    todo.status === "completed" && "text-muted-foreground",
                    todo.status === "cancelled" && "text-muted-foreground line-through",
                  )}
                >
                  {todo.content}
                </span>
              </li>
            )
          })}
        </ul>
      ) : undefined}
    </Tool>
  )
}
