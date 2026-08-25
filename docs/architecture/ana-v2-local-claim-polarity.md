# Ana v2 — polaridade local de claims

## Invariante

**A polaridade pertence ao claim local de cada horário explícito, nunca à
mensagem, sentença ou span inteiro.** Uma negativa só governa o horário que o
predicado local licencia. Uma negação local nunca pode licenciar, suprimir ou
reclassificar outro horário coordenado, anterior ou posterior.

Isso vale para escolha de serviço, evidência semântica, disponibilidade,
confirmação de write, cancelamento e correções do usuário.

**FAIL-CLOSED-CLAIM-1 — Toda menção operacional potencialmente verificável deve
terminar em uma classificação explícita. "Não classificado" é estado
conservador, nunca ausência de claim.**

```text
"não X, mas Y"   -> X negativo, Y positivo
"não X e Y"      -> analisar X e Y separadamente se Y abre novo claim
"não, quero Y"   -> Y positivo
"não quero Y"    -> Y negativo
```

Disponibilidade aplica a mesma regra com escopo operacional. A autoridade é o
classificador por horário em `src/services/availabilityClaimScope.ts`,
consumido por `customerReplyGuard` e `receptionistOutbound`; o splitter de
`e`/vírgula continua apenas como ferramenta auxiliar de delimitação. Listas
como `temos 10:00 e 10:30` produzem um claim direto e uma herança coordenada,
sem transformar a frase em uma licença única.

O helper retorna uma menção para **cada horário extraído**, inclusive quando
nenhum predicado conhecido o governa. Assim, "zero horários extraídos" e
"horários extraídos, mas nenhum claim reconhecido" são estados diferentes. No
segundo caso, cada horário recebe no mínimo `unknown/unclassified` e continua
exigindo evidência autoritativa na fronteira.

O contrato medido é:

```ts
type AvailabilityTimeMentionV2 = {
  time: string;
  span: { start: number; end: number };
  disposition:
    | 'positive_availability'
    | 'negative_availability'
    | 'non_availability_reference'
    | 'unknown';
  source:
    | 'predicate_before'
    | 'status_after'
    | 'coordinated_inheritance'
    | 'explicit_exclusion'
    | 'unclassified';
  exclusionReason?:
    | 'customer_constraint'
    | 'business_hours'
    | 'appointment_context'
    | 'other_typed_reference';
};
```

`positive_availability` e `unknown` exigem prova autoritativa. São as únicas
disposições que entram neste guard específico. `negative_availability` não é
oferta, e `non_availability_reference` só deixa de entrar porque o helper
reconheceu positivamente uma categoria distinta, com razão tipada: restrição
do cliente, horário comercial, contexto de agendamento ou outra referência
tipada. Isso não licencia globalmente a frase; as barreiras responsáveis por
essas categorias continuam ativas. A herança coordenada só é usada no mesmo
grupo local, quando não existe novo predicado entre o horário já classificado e
o próximo horário, e nunca transporta `non_availability_reference`.

O vocabulário de resultado tem uma única fonte:

```ts
const RESULT_LEADS = [
  'tenho', 'tem', 'temos', 'ha', 'encontrei', 'achei', 'localizei',
  'consegui encontrar', 'consegui localizar',
];
```

A forma negativa é derivada estruturalmente como `não + lead`; não existe uma
lista negativa paralela que possa esquecer um verbo que a lista positiva
conhece.

O mesmo vale para estados. Os núcleos `está`, `fica`, `ficou` e `tá` são uma
fonte comum para as formas completas e elípticas: os estados positivos
(`está disponível`/`está livre`) e o lead de vaga (`tem vaga`), os estados
negativos (`não está disponível`/`não está livre`), a elipse positiva
(`está`/`fica` sozinhos depois de o grupo local estabelecer o adjetivo) e a
elipse negativa (`não está`/`não fica`). A polaridade do adjetivo e a presença
da negação são derivadas dessa mesma gramática de estado; não há uma regex
positiva e outra negativa mantidas em paralelo.

## Oito instâncias medidas nesta onda

1. A polaridade do IA-25c recortou o `não` do span.
2. A definição de `ambiguous` no prompt do classificador empurrou para
   ambiguidade quando a frase citava duas partes do corpo.
3. O cue negativo do guard de disponibilidade não reconhecia
   `encontrei`/`achei`/`localizei`.
4. Sob a regra de composição do probe, o modelo propôs o serviço NEGADO em
   10/10.
5. A primeira iteração do próprio IA-26b tratou polaridade como propriedade
   do span inteiro: em `Temos 10:00 e não temos 10:30`, a negação posterior
   marcou o span todo como negativo e suprimiu a oferta legítima de `10:00`.
   Os casos `Não encontrei horários hoje e amanhã tenho 10:00` e `... e o
   15:00 está disponível` também mostraram que ampliar o splitter para cobrir
   advérbios, artigos e novas coordenações apenas deslocaria o bypass.

   A regra derivada desta instância é mais forte: a licença é **por horário**,
   não por frase/span. Cada ocorrência encontra seu predicado anterior, seu
   estado imediatamente posterior ou uma herança coordenada limitada. E o
   vocabulário negativo é sempre derivado do vocabulário positivo, nunca
   mantido em paralelo.

6. A segunda implementação do IA-26b cobriu a elipse de estado negativa
   (`não está`) e esqueceu a elipse positiva (`está` sozinho). No caso
   `O 10:00 não está disponível e o 10:30 está.`, o primeiro horário recebia
   `negative/status_after`, mas o segundo caía em
   `negative/coordinated_inheritance`; com o trace vazio, a barreira aceitava
   uma afirmação positiva sem leitura autoritativa no turno. É a sexta
   instância desta classe nesta onda e a terceira vez que a assimetria aparece
   dentro de um exec criado para fechar exatamente essa classe. O defeito não
   é só uma lacuna lexical: ele mostra que polaridade ainda estava sendo
   modelada como propriedade parcial da forma reconhecida.

   A regra derivada é obrigatória para todas as famílias: **toda forma
   reconhecida em uma polaridade tem de ser derivada, não duplicada, na outra**.
   Isso vale para result leads, estados e elipses. Um predicado ou estado local,
   de qualquer polaridade, sempre vence `coordinated_inheritance`; herança só
   pode ocorrer quando nenhum predicado ou estado local governa o horário.

7. A iteração anterior do IA-26b moveu novamente o default inseguro: antes,
   um span com cue negativo podia suprimir o span inteiro; depois da correção
   local, uma forma não catalogada passou a produzir **nenhum claim**. Nos
   dois casos, a ausência de reconhecimento virou licença. Os exemplos
   `O 10:00 e o 10:30 estão disponíveis` e `Estão livres 10:00 e 10:30`
   reproduziram a regressão: o predicado vinha depois dos horários e o helper
   retornava zero. A regra nova é mais básica e independente de novas regex:
   todo horário extraído recebe uma menção; o que não puder ser provado como
   oferta, negativa ou exclusão tipada recebe `unknown/unclassified` e exige
   evidência.

8. A exclusão tipada, introduzida para tornar as exclusões um reconhecimento
   positivo, ainda estava sendo calculada no escopo da sentença. Em
   `Fechamos às 20:00 e tenho 18:00.`, o cue `fechamos às` governa somente
   `20:00`, mas a implementação também classificava `18:00` como
   `non_availability_reference/business_hours`. O horário vizinho tinha um
   predicado próprio (`tenho`) e, portanto, a exclusão estava vencendo a
   governança local.

   A correção delimita cada cue à menção que ele governa. `predicate_before` e
   `status_after` do próprio horário são resolvidos antes de qualquer exclusão;
   somente na ausência de governança local a exclusão tipada é considerada. A
   exclusão, por sua vez, é resolvida antes da herança coordenada. Herança não
   pode transformar uma exclusão em outra exclusão: um horário coordenado sem
   predicado, estado ou cue de exclusão próprio recebe `unknown/unclassified`.
   Range explícito (`das 08:00 às 18:00`, `entre 10:00 e 10:30`) é uma relação
   lexical direta, não `coordinated_inheritance`.

   A precedência implementada em
   `src/services/availabilityClaimScope.ts` é:

   | Ordem | Fonte local | Resultado |
   | --- | --- | --- |
   | 1 | `predicate_before` / `status_after` do próprio horário | vence `explicit_exclusion`; conserva a polaridade local |
   | 2 | `explicit_exclusion` do cue local | marca somente a menção governada como `non_availability_reference` |
   | 3 | `coordinated_inheritance` | herda somente `positive_availability`, `negative_availability` ou `unknown`; nunca `non_availability_reference` |
   | 4 | nenhuma fonte | `unknown/unclassified`, sempre `evidence_required` |

   **SCOPE-1 — Toda classificação, inclusive exclusão tipada, pertence ao
   horário que o cue governa. Nenhum reconhecimento pode alcançar horário
   coordenado que tenha governança própria, e exclusão nunca se propaga por
   herança.**

Não há um regex universal para esses casos. O escopo e a polaridade devem ser
reutilizados dentro da fronteira comum, enquanto cada domínio mantém o seu
vocabulário e as suas provas autoritativas.
