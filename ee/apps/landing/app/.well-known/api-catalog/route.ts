export const dynamic = "force-static"

const linkset = {
  linkset: [
    {
      anchor: "https://api.omnirushlabs.com",
      "service-desc": [
        {
          href: "https://api.omnirushlabs.com/openapi.json",
          type: "application/vnd.oai.openapi+json;version=3.1",
          title: "OmniRush.ai Den API — OpenAPI 3.1 document",
        },
      ],
      "service-doc": [
        {
          href: "https://omnirushlabs.com/docs/api-reference",
          type: "text/html",
          title: "OmniRush.ai Den API — human documentation",
        },
      ],
      status: [
        {
          href: "https://api.omnirushlabs.com/health",
          type: "application/json",
          title: "OmniRush.ai Den API — health endpoint",
        },
      ],
      "service-meta": [
        {
          href: "https://omnirushlabs.com/llms.txt",
          type: "text/plain",
          title: "OmniRush.ai llms.txt — agent-facing site guide",
        },
      ],
    },
  ],
}

export function GET() {
  return new Response(JSON.stringify(linkset, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/linkset+json",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  })
}
