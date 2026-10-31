import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

/**
 * 带「显示 / 隐藏」的密码输入框。
 *
 * 为什么要这个：密码框默认打码，输错一个字符肉眼看不出来，只能整段删掉重来。
 * 尤其是注册和改密码这种"要输两遍"的地方，没有明文按钮基本等于逼人复制粘贴。
 *
 * 按钮用眼睛图标（Lucide 的 Eye / EyeOff），跟大多数站点一致：
 * 打码时显示睁眼，点开后显示带斜杠的闭眼。
 */
export function PasswordField({
  label,
  value,
  onChange,
  placeholder,
  autoComplete,
  autoFocus,
  maxLength = 128,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoComplete?: string;
  autoFocus?: boolean;
  maxLength?: number;
}) {
  const [visible, setVisible] = useState(false);
  const hint = visible ? '隐藏密码' : '显示密码';

  return (
    <label className="field">
      <span>{label}</span>
      <span className="password-wrap">
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
        />
        <button
          type="button"
          className="reveal"
          aria-label={hint}
          aria-pressed={visible}
          title={hint}
          tabIndex={-1}
          // 别把焦点从输入框抢走，否则点一下眼睛就得重新点回输入框
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? (
            <EyeOff size={18} strokeWidth={1.8} aria-hidden="true" />
          ) : (
            <Eye size={18} strokeWidth={1.8} aria-hidden="true" />
          )}
        </button>
      </span>
    </label>
  );
}
