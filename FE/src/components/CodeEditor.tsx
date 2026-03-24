import CodeMirror from '@uiw/react-codemirror'
import { python } from '@codemirror/lang-python'
import { oneDark } from '@codemirror/theme-one-dark'

interface Props {
  value: string
  onChange: (value: string) => void
  height?: string
  readOnly?: boolean
}

export function CodeEditor({ value, onChange, height = '100%', readOnly = false }: Props) {
  return (
    <CodeMirror
      value={value}
      height={height}
      theme={oneDark}
      extensions={[python()]}
      onChange={onChange}
      readOnly={readOnly}
      basicSetup={{
        lineNumbers: true,
        foldGutter: true,
        autocompletion: true,
      }}
      style={{ fontSize: 13, height: '100%' }}
    />
  )
}
