import WhatsAppTestPanel from "./WhatsAppTestPanel";

export const dynamic = "force-dynamic";

export default function WhatsAppTestPage() {
  if (process.env.WHATSAPP_TEST_MODE !== "true") {
    return (
      <main style={{ maxWidth: 680, margin: "48px auto", padding: 24, fontFamily: "system-ui, sans-serif" }}>
        <h1>WhatsApp test mode is disabled</h1>
        <p>This one-message test page is available only when WHATSAPP_TEST_MODE=true is enabled for the current deployment.</p>
      </main>
    );
  }

  return <WhatsAppTestPanel />;
}
