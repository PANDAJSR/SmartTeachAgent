import { useMemo, useState } from "react";
import { Bubble, Sender } from "@ant-design/x";
import { Card, Space, Typography } from "antd";

function App() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState([]);

  const roles = useMemo(
    () => ({
      ai: { placement: "start", variant: "borderless" },
      user: { placement: "end", variant: "filled" },
    }),
    []
  );

  const sendMessage = async (text) => {
    const clean = text.trim();
    if (!clean || loading) {
      return;
    }

    const userKey = `user-${Date.now()}`;
    const aiKey = `ai-${Date.now()}`;

    setItems((prev) => [
      ...prev,
      { key: userKey, role: "user", content: clean },
      { key: aiKey, role: "ai", content: "思考中..." },
    ]);
    setInput("");
    setLoading(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: clean }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "请求失败");
      }

      setItems((prev) =>
        prev.map((item) =>
          item.key === aiKey ? { ...item, content: data.reply } : item
        )
      );
    } catch (error) {
      setItems((prev) =>
        prev.map((item) =>
          item.key === aiKey
            ? {
                ...item,
                content:
                  error instanceof Error
                    ? `调用失败：${error.message}`
                    : "调用失败：未知错误",
              }
            : item
        )
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="page">
      <Card className="chat-card" variant="borderless">
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <div className="header">
            <Typography.Title level={3} style={{ margin: 0 }}>
              SmartTeach Agent Demo
            </Typography.Title>
            <Typography.Text type="secondary">
              前端：Ant Design X ｜ 后端：Claude Agent SDK
            </Typography.Text>
          </div>

          <div className="chat-window">
            <Bubble.List items={items} role={roles} autoScroll />
          </div>

          <Sender
            value={input}
            loading={loading}
            placeholder="输入你的教学场景问题，回车发送"
            onChange={setInput}
            onSubmit={sendMessage}
            submitType="enter"
            autoSize={{ minRows: 2, maxRows: 6 }}
          />
        </Space>
      </Card>
    </main>
  );
}

export default App;
