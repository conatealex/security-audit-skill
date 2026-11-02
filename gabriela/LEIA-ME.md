# Site da Gabriela Sousa — entrega de 02/11/2026 (versão 2)

`site-gabriela-2026-11-02-v2.zip` é o site pronto para publicar no Netlify.

## O que mudou nesta versão (v2)

1. **Menu rápido radial** (canto inferior direito): botão flutuante em vinho
   escuro `#4A0E17` que se transforma num círculo central e abre, em leque,
   cinco atalhos — **Agendar** (abre a página de horários), **Serviços**,
   **Atendimento**, **Valores** e **Contato**. Fecha com `Esc`, clique fora ou
   ao escolher um atalho; respeita "reduzir movimento" do sistema.
2. **Acesso ao painel de confirmações**: link discreto no rodapé do site
   ("Área da Gabriela — confirmar horários") e no rodapé da página de agenda
   ("É a Gabriela? Abrir o painel"). O painel continua protegido por token.
3. **Botão do WhatsApp** foi para a esquerda (acima do "voltar ao topo") para
   não disputar o canto com o menu rápido.
4. Nada do que já existia foi removido: hero, fotos, seções, agenda e painel
   seguem iguais.

## Como publicar

1. Baixe o ZIP (ou arraste a pasta `site/` depois de descompactar).
2. Acesse https://app.netlify.com/drop e arraste o ZIP.
3. Pronto: o `index.html` é a home e o Netlify aplica os cabeçalhos do `netlify.toml`.

## Acesso da Gabriela ao painel

O painel é a página `admin.html` do próprio site. Ela entra de duas formas:

- link direto com o token no final (`https://SEU-SITE/admin.html#TOKEN`);
- ou abrindo `admin.html` e colando o token no campo "Link ou token de acesso".

**O token não fica escrito neste repositório (que é público).** Ele está no
arquivo `ACESSO-PAINEL-GABRIELA.txt`, na pasta "Claude Projetos" do Google Drive.

Para lembrar: o token é guardado no banco só como *hash* — quem não tem o token
não entra, e o token nunca viaja pela rede.
