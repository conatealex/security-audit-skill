# Site da Gabriela Sousa — entrega de 02/11/2026 (versão 3)

`site-gabriela-2026-11-03-v3.zip` é o site pronto para publicar no Netlify.

## O que mudou nesta versão (v3)

1. **Botão do menu rápido maior e mais alto**: diâmetro de até 78 px e
   `bottom: 96px` — sai de cima do selo "Powered by Netlify", que antes
   encostava nele.
2. **Espaço branco em destaque**: ao abrir, o botão expande um disco branco
   (com aro cobre) sobre um véu vinho leve. Os **5 ícones ficaram maiores**
   (até 66 px de aba, ícones de 30 px) e ganharam borda mais definida para
   aparecer bem sobre o branco.
3. **Painel de confirmações consertado**: o `admin.html` estava com a chave
   pública do Supabase **vazia**, então toda requisição voltava 401. Agora
   entra normalmente.
4. **"Manter conectada neste aparelho por 30 dias"**: caixa marcada por
   padrão no painel; depois do primeiro acesso basta abrir `admin.html`.
5. **Links diretos para o painel** (com senha/token):
   - seção "Agenda" do site: botão **"É a Gabriela? Confirmar horários"**;
   - rodapé do site e rodapé da página de agenda.
6. Nada do que já existia foi removido: hero, fotos, seções e agenda seguem
   iguais.

## Como publicar

1. Baixe o ZIP (ou arraste a pasta `site/` depois de descompactar).
2. Acesse https://app.netlify.com/drop e arraste o ZIP na página do site.
3. Pronto: o `index.html` é a home e o Netlify aplica os cabeçalhos do `netlify.toml`.

## Acesso da Gabriela ao painel

O painel é a página `admin.html`. Duas formas de entrar:

- **link direto com o token** (`https://SEU-SITE/admin.html#TOKEN`) — abre já conectado;
- abrir `admin.html` e colar o token no campo "Link ou token de acesso".

**O token não fica escrito neste repositório (que é público).** Ele está no
arquivo `ACESSO-PAINEL-GABRIELA.txt`, na pasta "Claude Projetos" do Google Drive,
junto com o QR code (`qr-painel-gabriela.png`) para abrir o painel pelo celular.

O banco guarda apenas o *hash* SHA-256 do token: quem não tem o token não entra,
e o token nunca viaja pela rede depois do login.
