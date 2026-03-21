import Editor from "@monaco-editor/react";
import { Button, Divider, Input, Modal, Space, Switch, Typography } from "antd";

type McpServerDraft = {
  id: string;
  enabled: boolean;
  name: string;
  url: string;
  headersText: string;
};

type SettingsModalProps = {
  open: boolean;
  loading: boolean;
  envEditorLoading: boolean;
  envEditorSaving: boolean;
  envEditorError: string;
  envEditorNotice: string;
  envFilePath: string;
  envFileContent: string;
  onClose: () => void;
  onSaveEnv: () => Promise<void>;
  onChangeEnvContent: (value: string) => void;
  configPath: string;
  configSaving: boolean;
  configError: string;
  configNotice: string;
  mcpServers: McpServerDraft[];
  onAddMcpServer: () => void;
  onRemoveMcpServer: (id: string) => void;
  onChangeMcpServer: (id: string, patch: Partial<Omit<McpServerDraft, "id">>) => void;
  onSaveConfig: () => Promise<void>;
};

function SettingsModal(props: SettingsModalProps) {
  const {
    open,
    loading,
    envEditorLoading,
    envEditorSaving,
    envEditorError,
    envEditorNotice,
    envFilePath,
    envFileContent,
    onClose,
    onSaveEnv,
    onChangeEnvContent,
    configPath,
    configSaving,
    configError,
    configNotice,
    mcpServers,
    onAddMcpServer,
    onRemoveMcpServer,
    onChangeMcpServer,
    onSaveConfig,
  } = props;

  return (
    <Modal
      title="设置"
      open={open}
      className="settings-modal"
      width="100vw"
      style={{ top: 0, margin: 0, paddingBottom: 0 }}
      onCancel={onClose}
      footer={[
        <Button key="close" onClick={onClose}>
          关闭
        </Button>,
      ]}
    >
      <Space direction="vertical" size={20} style={{ width: "100%" }}>
        <div>
          <Typography.Title level={5} style={{ marginTop: 0 }}>
            HTTP MCP 服务器
          </Typography.Title>
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            <Typography.Text type="secondary">配置文件：{configPath}</Typography.Text>
            {configError ? <Typography.Text type="danger">{configError}</Typography.Text> : null}
            {configNotice ? <Typography.Text type="success">{configNotice}</Typography.Text> : null}

            {mcpServers.map((server, index) => (
              <div key={server.id} className="mcp-server-item">
                <Space direction="vertical" size={8} style={{ width: "100%" }}>
                  <Space align="center" style={{ width: "100%", justifyContent: "space-between" }}>
                    <Typography.Text strong>服务器 {index + 1}</Typography.Text>
                    <Button
                      danger
                      type="text"
                      onClick={() => onRemoveMcpServer(server.id)}
                      disabled={loading || mcpServers.length <= 1}
                    >
                      删除
                    </Button>
                  </Space>

                  <Space size={12} align="center" wrap>
                    <Typography.Text>启用</Typography.Text>
                    <Switch
                      checked={server.enabled}
                      onChange={(value) => onChangeMcpServer(server.id, { enabled: value })}
                      disabled={loading}
                    />
                  </Space>

                  <Input
                    value={server.name}
                    onChange={(event) => onChangeMcpServer(server.id, { name: event.target.value })}
                    placeholder="服务器名称，例如 mac-mini"
                    disabled={loading}
                  />
                  <Input
                    value={server.url}
                    onChange={(event) => onChangeMcpServer(server.id, { url: event.target.value })}
                    placeholder="HTTP 地址，例如 http://192.168.1.8:8787/mcp"
                    disabled={loading}
                  />
                  <Input.TextArea
                    value={server.headersText}
                    onChange={(event) =>
                      onChangeMcpServer(server.id, { headersText: event.target.value })
                    }
                    placeholder='可选：请求头 JSON，例如 {"Authorization":"Bearer xxx"}'
                    autoSize={{ minRows: 3, maxRows: 6 }}
                    disabled={loading}
                  />
                </Space>
              </div>
            ))}

            <Space size={8} wrap>
              <Button onClick={onAddMcpServer} disabled={loading}>
                新增服务器
              </Button>
              <Button type="primary" onClick={() => void onSaveConfig()} loading={configSaving}>
                保存 MCP 配置
              </Button>
            </Space>
          </Space>
        </div>

        <Divider style={{ margin: 0 }} />

        <div>
          <Typography.Title level={5} style={{ marginTop: 0 }}>
            编辑环境变量 .env
          </Typography.Title>
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            <Typography.Text type="secondary">{envFilePath}</Typography.Text>
            {envEditorError ? <Typography.Text type="danger">{envEditorError}</Typography.Text> : null}
            {envEditorNotice ? <Typography.Text type="success">{envEditorNotice}</Typography.Text> : null}
            <Button
              type="primary"
              loading={envEditorSaving}
              onClick={() => void onSaveEnv()}
              disabled={envEditorLoading || loading}
            >
              保存 .env
            </Button>
            <Editor
              height="52vh"
              defaultLanguage="ini"
              value={envFileContent}
              loading="正在加载 .env 文件..."
              options={{
                minimap: { enabled: false },
                fontSize: 14,
                wordWrap: "on",
                automaticLayout: true,
                lineNumbers: "on",
                scrollBeyondLastLine: false,
              }}
              onChange={(value) => onChangeEnvContent(value || "")}
            />
          </Space>
        </div>
      </Space>
    </Modal>
  );
}

export default SettingsModal;
