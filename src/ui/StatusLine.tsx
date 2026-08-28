import { useConnection } from "../store/connection";

/** 底部状态/日志提示行,带闪烁光标 */
export function StatusLine() {
  const { message } = useConnection();
  return (
    <div className="statusline" title={message}>
      {message}
      <span className="cursor">&nbsp;</span>
    </div>
  );
}
