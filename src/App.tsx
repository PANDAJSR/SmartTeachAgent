import { Bubble, Conversations, Sender } from "@ant-design/x";
import { Button, Card, Select, Space, Tooltip, Typography } from "antd";
import { useEffect } from "react";
import SettingsModal from "./components/SettingsModal";
import { useAsr } from "./app/hooks/useAsr";
import { useChat } from "./app/hooks/useChat";
import { useSettings } from "./app/hooks/useSettings";
import { useTts } from "./app/hooks/useTts";
import { ASR_MODEL_SELECT_OPTIONS } from "./app/types";

function App() {
  const tts = useTts();
  const chat = useChat({
    ttsGenerating: tts.ttsGenerating,
    ttsPlaying: tts.ttsPlaying,
    playTtsText: tts.playTtsText,
    stopTtsPlayback: tts.stopTtsPlayback,
  });
  const asr = useAsr({
    loading: chat.loading,
    appendTranscript: chat.appendTranscript,
  });
  const settings = useSettings();

  useEffect(() => {
    return () => {
      asr.cleanupAsr();
      tts.cleanupTts();
    };
  }, [asr, tts]);

  return (
    <main className="page">
      <Card className="chat-card" variant="borderless">
        <div className="app-layout">
          <aside className="conversation-panel">
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              <div className="conversation-panel-header">
                <Typography.Title level={4} style={{ margin: 0 }}>
                  对话列表
                </Typography.Title>
              </div>
              <Conversations
                items={chat.conversationItems}
                activeKey={chat.activeConversationId}
                onActiveChange={(value) => chat.setActiveConversationId(String(value))}
                creation={{
                  disabled: chat.loading,
                  onClick: chat.createNewConversation,
                }}
              />
            </Space>
          </aside>

          <section className="chat-panel">
            <Space direction="vertical" size={16} style={{ width: "100%" }}>
              <div className="header">
                <div className="header-top">
                  <Typography.Title level={3} style={{ margin: 0 }}>
                    智教助手
                  </Typography.Title>
                  <Button
                    type="text"
                    aria-label="打开设置"
                    title="设置"
                    onClick={() => void settings.openSettings()}
                    disabled={chat.loading}
                    icon={<i className="fa-solid fa-gear" aria-hidden="true" />}
                  />
                </div>
                <Typography.Text type="secondary">前端：Ant Design X ｜ 后端：Claude Agent SDK</Typography.Text>
              </div>

              <div className="chat-window">
                {chat.activeItems.length > 0 ? (
                  <Bubble.List items={chat.activeItems} role={chat.roles as never} autoScroll />
                ) : (
                  <div className="empty-tip">开始一个新对话，问点什么吧。</div>
                )}
              </div>

              <Sender
                value={chat.input}
                loading={chat.loading}
                placeholder="输入你的问题，回车发送"
                onChange={chat.setInput}
                onSubmit={chat.sendMessage}
                onCancel={chat.handleCancel}
                submitType="enter"
                autoSize={{ minRows: 2, maxRows: 6 }}
                disabled={!chat.activeConversation}
                suffix={(oriNode) => (
                  <Space size={4}>
                    <Tooltip
                      title={
                        asr.recording
                          ? "点击停止录音"
                          : asr.transcribing
                            ? "正在识别语音，请稍候"
                            : "点击开始语音输入"
                      }
                    >
                      <Button
                        type={asr.recording ? "primary" : "text"}
                        danger={asr.recording}
                        shape="circle"
                        aria-label={asr.recording ? "停止语音输入" : "开始语音输入"}
                        title={asr.recording ? "停止语音输入" : "开始语音输入"}
                        icon={
                          <i
                            className={asr.recording ? "fa-solid fa-stop" : "fa-solid fa-microphone"}
                            aria-hidden="true"
                          />
                        }
                        onClick={asr.toggleRecording}
                        disabled={!chat.activeConversation || chat.loading || asr.transcribing}
                      />
                    </Tooltip>
                    {oriNode}
                  </Space>
                )}
              />

              <Space size={8} wrap>
                <Select
                  value={asr.asrModelId}
                  options={ASR_MODEL_SELECT_OPTIONS}
                  style={{ minWidth: 210 }}
                  size="small"
                  onChange={(value) => asr.setAsrModelId(String(value))}
                  disabled={asr.recording || asr.transcribing || chat.loading || asr.asrPreloading}
                />
                <Button
                  size="small"
                  onClick={() => void asr.preloadAsrModel()}
                  loading={asr.asrPreloading}
                  disabled={asr.recording || asr.transcribing || chat.loading || asr.asrPreloading}
                >
                  {asr.asrReadyMap[asr.asrModelId] ? "模型已就绪" : "预加载语音模型"}
                </Button>
              </Space>

              {(asr.recording || asr.transcribing || asr.asrError) && (
                <Typography.Text type={asr.asrError ? "danger" : "secondary"}>
                  {asr.asrError
                    ? `语音输入失败：${asr.asrError}`
                    : asr.recording
                      ? "录音中，点击麦克风按钮结束并开始识别..."
                      : `正在加载并运行语音识别模型（${asr.asrModelLabel}）...`}
                </Typography.Text>
              )}

              {(tts.ttsGenerating || tts.ttsPlaying || tts.ttsError) && (
                <Typography.Text type={tts.ttsError ? "danger" : "secondary"}>
                  {tts.ttsError
                    ? `语音朗读失败：${tts.ttsError}`
                    : tts.ttsGenerating
                      ? "正在生成朗读音频，请稍候..."
                      : "正在朗读中，点击“停止朗读”可中断播放。"}
                </Typography.Text>
              )}
            </Space>
          </section>
        </div>
      </Card>

      <SettingsModal
        open={settings.settingsOpen}
        loading={settings.settingsLoading}
        envEditorLoading={settings.envEditorLoading}
        envEditorSaving={settings.envEditorSaving}
        envEditorError={settings.envEditorError}
        envEditorNotice={settings.envEditorNotice}
        envFilePath={settings.envFilePath}
        envFileContent={settings.envFileContent}
        onClose={() => settings.setSettingsOpen(false)}
        onSaveEnv={settings.saveEnvFile}
        onChangeEnvContent={settings.setEnvFileContent}
        configPath={settings.configPath}
        configSaving={settings.configSaving}
        configError={settings.configError}
        configNotice={settings.configNotice}
        mcpServers={settings.mcpServers}
        mcpTestingMap={settings.mcpTestingMap}
        mcpTestResultMap={settings.mcpTestResultMap}
        onAddMcpServer={settings.addMcpServer}
        onRemoveMcpServer={settings.removeMcpServer}
        onChangeMcpServer={settings.updateMcpServer}
        onTestMcpServer={settings.testMcpServerConnection}
        onSaveConfig={settings.saveConfigFile}
      />
    </main>
  );
}

export default App;
