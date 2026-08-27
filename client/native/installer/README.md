# Instalador Windows

O instalador da v1 usa Inno Setup e entrega o publish x64 do WPF junto dos
assets React. Baixe o bootstrapper Evergreen do WebView2 como
`MicrosoftEdgeWebview2Setup.exe` nesta pasta antes de compilar o instalador.

O pipeline de release deve executar, nesta ordem:

1. gerar `client/ui/dist`;
2. publicar `Talkeando.Client` para `win-x64` em Release;
3. chamar o Inno Setup com `/DAppVersion=<versão>` e `/DPublishDir=<publish>`;
4. assinar o executável e o instalador quando o certificado estiver disponível;
5. publicar checksum SHA-256 e changelog junto ao `.exe` gerado.

O bootstrapper nunca contém credenciais do servidor; a URL pública é uma
configuração de implantação da aplicação nativa.
