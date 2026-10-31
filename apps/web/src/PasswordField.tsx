import { useState } from 'react';

/**
 * 带「显示 / 隐藏」的密码输入框。
 *
 * 为什么要这个：密码框默认打码，输错一个字符肉眼看不出来，只能整段删掉重来。
 * 尤其是注册和改密码这种"要输两遍"的地方，没有明文按钮基本等于逼人复制粘贴。
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
          aria-label={visible ? '隐藏密码' : '显示密码'}
          aria-pressed={visible}
          tabIndex={-1}
          // 别把焦点从输入框抢走，否则点一下"显示"就得重新点回输入框
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? '隐藏' : '显示'}
        </button>
      </span>
    </label>
  );
}
