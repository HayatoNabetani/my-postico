# My Postico

macOS向けの個人用PostgreSQL GUIクライアントです。GUIで組み立てる高機能フィルターとSSHトンネル接続を中心にしています。

## 実装済み

- PostgreSQL接続プロファイルの作成・編集・削除
- DBパスワード、SSHパスワード、秘密鍵パスフレーズのmacOS Keychain保存
- SSL接続（Disable / Prefer / Require / Verify Full）
- SSHトンネル（パスワード、秘密鍵、SSH Agent）
- SSHホスト鍵のSHA-256フィンガープリント確認と変更検知
- スキーマ、テーブル、ビュー、カラムの読み込み
- 100行単位のデータグリッドとページング
- 主キー・外部キーと参照先のカラム表示
- ダブルクリックによるセル編集と、適用ボタンによる一括反映
- AND / OR、ネスト、型別演算子を備えたフィルタービルダー
- パラメーター化されたフィルターSQL
- クイックフィルター、フィルター保存・復元、SQLプレビュー
- 読み取りSQLエディタと名前付きクエリー保存
- ブラウザ式の複数テーブルタブ
- ウィンドウの移動・リサイズ、サイドバー幅とSQLエディタ高さのドラッグ調整

## 開発

必要な環境:

- Node.js 20以降
- Rust stable
- macOSのXcode Command Line Tools

```bash
npm install
npm run tauri dev
```

フロントエンドだけを確認する場合:

```bash
npm run dev
```

## 検証

```bash
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

## 現在の制限

- 主キーがないテーブルとビューは安全に行を特定できないため編集できません。
- SQLエディタは読み取りクエリのみ実行できます。
- SSHは単一の踏み台サーバーに対応し、多段SSHには未対応です。
- 実際のPostgreSQL/SSHサーバーを使う接続テストは環境ごとに実施してください。

詳細は [プロダクト仕様書](docs/product-spec.md) を参照してください。
