# イマクル公式サイト

乗り遅れ防止通知アプリ「イマクル」の公式サイトです。

- 公開URL: https://keyanbaitian6-cell.github.io/
- サポート: https://keyanbaitian6-cell.github.io/support.html
- プライバシーポリシー: https://keyanbaitian6-cell.github.io/privacy.html
- 利用規約: https://keyanbaitian6-cell.github.io/terms.html

## 構成

外部フレームワークやアクセス解析を使わない静的HTML/CSS/JavaScriptです。`main`へのpushでGitHub ActionsがGitHub Pagesへデプロイします。

## ローカル確認

任意の静的HTTPサーバーでリポジトリルートを配信してください。

```sh
python -m http.server 8080
```

## 更新時の注意

- App Store / Google Playの公開後に、トップページのストアリンクと公開状況を更新する。
- 位置情報・購読・外部サービスの扱いが変わった場合は、アプリ本体の原本と`privacy.html`を同時に更新する。
- サポート窓口を変更した場合は、全HTML内のメールアドレスを更新する。
