# Site da Gabriela Sousa — entrega de 02/11/2026

`site-gabriela-2026-11-02.zip` é o site pronto para publicar no Netlify.

## O que mudou nesta versão

1. **Fotos novas**, as duas enviadas pela Gabriela:
   - topo (hero): busto recortado, com contorno branco suave e transparência;
   - seção "Espaço" (nova): foto dela sentada no consultório;
   - seção "Sobre": retrato com fundo de estúdio claro.
2. **Foto do topo bem maior**: recorte 858 × 1084 (só a pessoa, sem margem
   transparente sobrando), coluna direita com até 700 px de largura.
3. **Fundo do topo com efeito 3D**: duas camadas do símbolo do infinito
   andando em velocidades diferentes (620 px desfocada a 70 s + 360 px nítida
   a 34 s) e símbolo com sombra projetada, brilho e contorno claro.
4. **Bordô mais suave**: degradê `#84183A → #61102A → #480C1E` e véu de leitura
   mais leve, para o símbolo voltar a aparecer.
5. As imagens saíram do base64: agora são arquivos em `assets/` (o `index.html`
   caiu de ~780 KB para ~51 KB).

## Como publicar

1. Baixe o ZIP (ou arraste a pasta `site/` depois de descompactar).
2. Acesse https://app.netlify.com/drop e arraste o ZIP.
3. Pronto: o `index.html` é a home, e o Netlify aplica os cabeçalhos do `netlify.toml`.

O link do painel (`admin.html`) não está neste pacote de propósito — peça o
token atualizado no arquivo `PAINEL-DA-GABRIELA.txt` do Google Drive.
