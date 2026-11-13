port module Main exposing (main)

import Browser
import Browser.Dom
import Charts
import Evidence
import Html exposing (..)
import Html.Attributes exposing (attribute, class, disabled, href, id, maxlength, placeholder, readonly, rel, required, style, target, title, type_, value)
import Html.Events exposing (onClick, onInput, onSubmit, preventDefaultOn)
import Html.Keyed
import Http
import Json.Decode as D
import Json.Encode as E
import Languages
import Lingo.Date as Date
import Lingo.Lang exposing (Lang(..))
import Lingo.Styles as Styles
import Lingo.Theme as Theme
import Task
import Time
import Url


type alias Model =
    { snapshot : Maybe D.Value, key : String, label : String, person : String, device : String, personFilter : String, days : String, error : String, pairing : String, pairingDevice : String, busy : Bool, generation : Int, page : Int, perPage : String, anchor : Maybe ( Float, Float ), personName : String, editing : Maybe DeviceEdit, light : Bool, historyOpen : Bool, query : String, kind : String, sort : String, evidence : Maybe D.Value, tab : Tab, languages : Languages.Model, session : Session }


type Tab
    = ObserverTab
    | LanguagesTab


type Session
    = CheckingSession
    | SignedOut
    | SignedIn


type alias DeviceEdit =
    { id : String, label : String, person : String }


type Msg
    = Key String
    | Label String
    | Person String
    | Filter String String
    | Login
    | Logout
    | Create
    | Revoke String
    | Refresh
    | Loaded Int (Result Http.Error D.Value)
    | LoggedIn (Result Http.Error D.Value)
    | LoggedOut (Result Http.Error D.Value)
    | Created (Result Http.Error D.Value)
    | Revoked (Result Http.Error D.Value)
    | PersonName String
    | CreatePerson
    | PersonCreated (Result Http.Error D.Value)
    | GoPage Int
    | EditDevice String
    | EditLabel String
    | EditPerson String
    | SaveDevice
    | DeviceSaved (Result Http.Error D.Value)
    | Rotate String
    | ToggleTheme
    | ToggleHistory
    | ShowHistory
    | ShowEvidence D.Value
    | CloseEvidence
    | SelectTab Tab
    | TabFocused (Result Browser.Dom.Error ())
    | LanguagesMsg Languages.Msg
    | CheckSession
    | SessionChecked (Result Http.Error D.Value)


port saveTheme : Bool -> Cmd msg


port evidenceDialog : Bool -> Cmd msg


port metrics : E.Value -> Cmd msg


measure : String -> Int -> String -> Bool -> Cmd msg
measure name generation phase ok =
    metrics (E.object [ ( "name", E.string name ), ( "generation", E.int generation ), ( "phase", E.string phase ), ( "ok", E.bool ok ) ])


initial : Model
initial =
    { snapshot = Nothing, key = "", label = "", person = "", device = "", personFilter = "", days = "7", error = "", pairing = "", pairingDevice = "", busy = False, generation = 0, page = 1, perPage = "20", anchor = Nothing, personName = "", editing = Nothing, light = False, historyOpen = False, query = "", kind = "all", sort = "recent", evidence = Nothing, tab = ObserverTab, languages = Languages.initial, session = CheckingSession }


main : Program Bool Model Msg
main =
    Browser.element
        { init = \light -> ( { initial | light = light }, checkSession )
        , update = update
        , view = view
        , subscriptions =
            \m ->
                if m.session /= SignedIn then
                    Sub.none

                else if m.tab == LanguagesTab then
                    Time.every 15000 (\_ -> LanguagesMsg Languages.Refresh)

                else if m.snapshot == Nothing || m.anchor /= Nothing || m.evidence /= Nothing then
                    Sub.none

                else
                    Time.every 15000 (\_ -> Refresh)
        }


load : Model -> Cmd Msg
load m =
    Cmd.batch
        [ measure "dashboard" m.generation "start" True
        , Http.request { method = "GET", headers = [], body = Http.emptyBody, timeout = Just 10000, tracker = Nothing, url = "/api/dashboard?days=" ++ m.days ++ "&device=" ++ Url.percentEncode m.device ++ "&person=" ++ Url.percentEncode m.personFilter ++ "&query=" ++ Url.percentEncode m.query ++ "&kind=" ++ m.kind ++ "&sort=" ++ m.sort ++ "&page=" ++ String.fromInt m.page ++ "&perPage=" ++ m.perPage ++ (m.anchor |> Maybe.map (\( seq, until ) -> "&before=" ++ String.fromFloat seq ++ "&until=" ++ String.fromFloat until) |> Maybe.withDefault ""), expect = Http.expectJson (Loaded m.generation) D.value }
        ]


checkSession : Cmd Msg
checkSession =
    Http.request { method = "GET", headers = [], body = Http.emptyBody, timeout = Just 10000, tracker = Nothing, url = "/api/session", expect = Http.expectJson SessionChecked D.value }


post : String -> List ( String, E.Value ) -> (Result Http.Error D.Value -> Msg) -> Cmd Msg
post url body msg =
    Http.post { url = url, body = Http.jsonBody (E.object body), expect = Http.expectJson msg D.value }


problem : Http.Error -> String
problem err =
    case err of
        Http.BadStatus 401 ->
            "Please sign in with your owner key."

        Http.BadStatus code ->
            "Server returned " ++ String.fromInt code

        Http.NetworkError ->
            "Cannot reach the server. Your collector keeps its local queue."

        Http.Timeout ->
            "Loading took too long. Please try again."

        _ ->
            "The request failed. Please try again."


update : Msg -> Model -> ( Model, Cmd Msg )
update msg m =
    case msg of
        CheckSession ->
            ( { m | session = CheckingSession, error = "" }, checkSession )

        SessionChecked result ->
            case result of
                Ok _ ->
                    let
                        next =
                            { m | session = SignedIn, error = "", generation = m.generation + 1 }
                    in
                    ( next, load next )

                Err (Http.BadStatus 401) ->
                    ( signedOut m, Cmd.none )

                Err err ->
                    ( { m | error = problem err }, Cmd.none )

        SelectTab tab ->
            let
                ( languages, cmd ) =
                    if tab == LanguagesTab && m.tab /= LanguagesTab then
                        Languages.refresh m.languages

                    else
                        ( m.languages, Cmd.none )
            in
            ( { m | tab = tab, languages = languages, evidence = Nothing }
            , Cmd.batch [ Cmd.map LanguagesMsg cmd, languageMeasurements m.languages languages Nothing, evidenceDialog False, Task.attempt TabFocused (Browser.Dom.focus (tabId tab)) ]
            )

        TabFocused _ ->
            ( m, Cmd.none )

        LanguagesMsg languageMsg ->
            if m.session /= SignedIn then
                ( m, Cmd.none )

            else
                case languageMsg of
                    Languages.Loaded generation (Err (Http.BadStatus 401)) ->
                        if generation == m.languages.generation then
                            ( signedOut m, evidenceDialog False )

                        else
                            ( m, Cmd.none )

                    Languages.ReviewLoaded generation (Err (Http.BadStatus 401)) ->
                        if generation == m.languages.reviewGeneration then
                            ( signedOut m, evidenceDialog False )

                        else
                            ( m, Cmd.none )

                    _ ->
                        let
                            ( languages, cmd ) =
                                Languages.update languageMsg m.languages
                        in
                        ( { m | languages = languages }, Cmd.batch [ Cmd.map LanguagesMsg cmd, languageMeasurements m.languages languages (Just languageMsg) ] )

        ShowEvidence record ->
            ( { m | evidence = Just record }, evidenceDialog True )

        CloseEvidence ->
            ( { m | evidence = Nothing }, evidenceDialog False )

        ToggleTheme ->
            ( { m | light = not m.light }, saveTheme (not m.light) )

        ToggleHistory ->
            ( { m | historyOpen = not m.historyOpen }, Cmd.none )

        ShowHistory ->
            ( { m | historyOpen = True }, Cmd.none )

        Key v ->
            ( { m | key = v }, Cmd.none )

        Label v ->
            ( { m | label = v }, Cmd.none )

        Person v ->
            ( { m | person = v }, Cmd.none )

        PersonName v ->
            ( { m | personName = v }, Cmd.none )

        CreatePerson ->
            ( { m | busy = True }, post "/api/people" [ ( "name", E.string m.personName ) ] PersonCreated )

        PersonCreated (Ok person) ->
            let
                next =
                    { m | busy = False, personName = "", person = str "id" person }
            in
            ( next, load next )

        PersonCreated (Err err) ->
            ( { m | busy = False, error = problem err }, Cmd.none )

        GoPage page ->
            let
                next =
                    { m | page = max 1 page, anchor = m.snapshot |> Maybe.map (\s -> ( num "snapshotSeq" s, num "until" s )), generation = m.generation + 1 }
            in
            ( next, load next )

        EditDevice deviceId ->
            ( { m | editing = m.snapshot |> Maybe.andThen (\s -> rows "devices" s |> List.filter (\d -> str "id" d == deviceId) |> List.head) |> Maybe.map (\d -> { id = deviceId, label = str "label" d, person = str "personId" d }) }, Cmd.none )

        EditLabel v ->
            ( { m | editing = Maybe.map (\d -> { d | label = v }) m.editing }, Cmd.none )

        EditPerson v ->
            ( { m | editing = Maybe.map (\d -> { d | person = v }) m.editing }, Cmd.none )

        SaveDevice ->
            case m.editing of
                Nothing ->
                    ( m, Cmd.none )

                Just d ->
                    ( { m | busy = True }, post ("/api/devices/" ++ Url.percentEncode d.id) [ ( "label", E.string d.label ), ( "person", E.string d.person ) ] DeviceSaved )

        DeviceSaved (Ok _) ->
            let
                next =
                    { m | busy = False, editing = Nothing, anchor = Nothing, page = 1, generation = m.generation + 1 }
            in
            ( next, load next )

        DeviceSaved (Err err) ->
            ( { m | busy = False, error = problem err }, Cmd.none )

        Rotate deviceId ->
            ( { m | busy = True, pairing = "" }, post ("/api/devices/" ++ Url.percentEncode deviceId ++ "/rotate") [] Created )

        Filter field v ->
            let
                next =
                    { m
                        | days =
                            if field == "days" then
                                v

                            else
                                m.days
                        , device =
                            if field == "device" then
                                v

                            else if field == "person" then
                                ""

                            else
                                m.device
                        , personFilter =
                            if field == "person" then
                                v

                            else
                                m.personFilter
                        , generation = m.generation + 1
                        , query =
                            if field == "query" then
                                v

                            else
                                m.query
                        , kind =
                            if field == "kind" then
                                v

                            else
                                m.kind
                        , sort =
                            if field == "sort" then
                                v

                            else
                                m.sort
                        , page = 1
                        , anchor = Nothing
                        , perPage =
                            if field == "perPage" then
                                v

                            else
                                m.perPage
                    }
            in
            ( next, load next )

        Login ->
            ( { m | busy = True, error = "" }, post "/api/login" [ ( "token", E.string m.key ) ] LoggedIn )

        LoggedIn (Ok _) ->
            let
                next =
                    { m | key = "", busy = False, session = SignedIn, generation = m.generation + 1 }
            in
            ( next, load next )

        LoggedIn (Err err) ->
            ( { m | busy = False, error = problem err }, Cmd.none )

        Logout ->
            ( m, post "/api/logout" [] LoggedOut )

        LoggedOut (Ok _) ->
            ( signedOut m, evidenceDialog False )

        LoggedOut (Err err) ->
            ( { m | error = problem err }, Cmd.none )

        Create ->
            ( { m | busy = True, error = "", pairing = "" }, post "/api/devices" [ ( "label", E.string m.label ), ( "person", E.string m.person ) ] Created )

        Created (Ok value_) ->
            ( { m | pairing = str "token" value_, pairingDevice = str "deviceId" value_, label = "", busy = False }, load m )

        Created (Err err) ->
            ( { m | busy = False, error = problem err }, Cmd.none )

        Revoke id_ ->
            ( m, post ("/api/devices/" ++ Url.percentEncode id_ ++ "/revoke") [] Revoked )

        Revoked (Ok _) ->
            ( m, load m )

        Revoked (Err err) ->
            ( { m | error = problem err }, Cmd.none )

        Refresh ->
            let
                next =
                    { m | anchor = Nothing, page = 1, generation = m.generation + 1 }
            in
            ( next, load next )

        Loaded generation result ->
            if generation /= m.generation then
                ( m, Cmd.none )

            else
                case result of
                    Ok snapshot ->
                        ( { m | snapshot = Just snapshot, page = round (num "page" snapshot), error = "" }, measure "dashboard" generation "end" True )

                    Err (Http.BadStatus 401) ->
                        ( signedOut m, evidenceDialog False )

                    Err (Http.BadStatus 410) ->
                        update Refresh m

                    Err err ->
                        ( { m | error = problem err }, measure "dashboard" generation "end" False )


languageMeasurements : Languages.Model -> Languages.Model -> Maybe Languages.Msg -> Cmd Msg
languageMeasurements previous next message =
    let
        completion =
            case message of
                Just (Languages.Loaded generation result) ->
                    if generation == next.generation then
                        measure "languages" generation "end" (Result.toMaybe result /= Nothing)

                    else
                        Cmd.none

                Just (Languages.ReviewLoaded generation result) ->
                    if generation == next.reviewGeneration then
                        measure "review" generation "end" (Result.toMaybe result /= Nothing)

                    else
                        Cmd.none

                _ ->
                    Cmd.none
    in
    Cmd.batch
        [ if previous.generation /= next.generation then measure "languages" next.generation "start" True else Cmd.none
        , if next.reviewLoading && previous.reviewGeneration /= next.reviewGeneration then measure "review" next.reviewGeneration "start" True else Cmd.none
        , completion
        ]


signedOut : Model -> Model
signedOut model =
    let
        languages =
            Languages.initial
    in
    { initial | generation = model.generation + 1, light = model.light, languages = { languages | generation = model.languages.generation + 1, reviewGeneration = model.languages.reviewGeneration + 1 }, session = SignedOut }


get : D.Decoder a -> a -> String -> D.Value -> a
get decoder fallback key value_ =
    D.decodeValue (D.field key decoder) value_ |> Result.withDefault fallback


str : String -> D.Value -> String
str =
    get D.string ""


num : String -> D.Value -> Float
num =
    get D.float 0


rows : String -> D.Value -> List D.Value
rows =
    get (D.list D.value) []


duration : Float -> String
duration n =
    let
        s =
            floor n
    in
    if s >= 3600 then
        String.fromInt (s // 3600) ++ "h " ++ String.fromInt (modBy 60 (s // 60)) ++ "m " ++ String.fromInt (modBy 60 s) ++ "s"

    else
        String.fromInt (s // 60) ++ "m " ++ String.fromInt (modBy 60 s) ++ "s"


view : Model -> Html Msg
view m =
    div
        (class "app observer"
            :: Theme.variables
                (if m.light then
                    Theme.light

                 else
                    Theme.dark
                )
                De
        )
        [ Styles.view
        , Evidence.view duration CloseEvidence m.evidence
        , div [ class "shell dashboard" ]
            [ header [ class "spread wrap" ]
                [ div [ class "row dashboard-title" ] [ h1 [ class "brand" ] [ span [ class "brand-mark", attribute "aria-hidden" "true" ] [ text "▶" ], text "YouTube Observer" ], span [ class "date-range" ] [ text "Your viewing record" ] ]
                , div [ class "row wrap" ]
                    [ a [ href "/#/history" ] [ text "History" ]
                    , a [ href "/android-integration.html", target "_blank", rel "noopener" ] [ text "Android integration" ]
                    , a [ href "/modules/languages/" ] [ text "Language review" ]
                    , a [ href "/diagnostics.html", target "_blank", rel "noopener" ] [ text "Diagnostics" ]
                    , button [ class "button", onClick ToggleTheme, attribute "aria-label" "Toggle color theme" ]
                        [ text
                            (if m.light then
                                "Dark theme"

                             else
                                "Light theme"
                            )
                        ]
                    , if m.session == SignedIn then
                        button [ class "button", onClick Logout ] [ text "Sign out" ]

                      else
                        text ""
                    ]
                ]
            , if m.error == "" then
                text ""

              else
                p [ class "error", attribute "role" "alert" ] [ text m.error ]
            , case m.session of
                CheckingSession ->
                    section [ class "card loading-state", attribute "role" "status", id "session-loading" ]
                        [ h2 [] [ text "Checking your session…" ]
                        , p [ class "muted" ] [ text "Restoring your owner sign-in." ]
                        , if m.error /= "" then
                            button [ class "button", onClick CheckSession ] [ text "Try again" ]

                          else
                            text ""
                        ]

                SignedOut ->
                    section [ class "login card" ]
                        [ h2 [] [ text "Welcome back." ]
                        , p [] [ text "One private dashboard for your devices and their watch history." ]
                        , form [ onSubmit Login ] [ label [] [ text "Owner key", input [ id "owner-key", type_ "password", value m.key, onInput Key, required True, attribute "autocomplete" "current-password" ] [] ], button [ disabled m.busy ] [ text (if m.busy then "Signing in…" else "Sign in") ] ]
                        , p [ class "muted" ] [ text "On the server, your first-run key is in data/admin-token." ]
                        ]

                SignedIn ->
                    div [ class "dashboard-views" ]
                        [ viewTabs m.tab
                        , case m.tab of
                            ObserverTab ->
                                case m.snapshot of
                                    Just snapshot ->
                                        dashboard m snapshot

                                    Nothing ->
                                        main_ [ class "card loading-state", id "observer-panel", attribute "role" "tabpanel", attribute "aria-labelledby" "observer-tab" ]
                                            [ h2 [ attribute "role" "status" ] [ text "Loading your viewing record…" ]
                                            , p [ class "muted" ] [ text "You’re signed in. Loading recorded playback and history." ]
                                            , if m.error /= "" then
                                                button [ class "button", onClick Refresh ] [ text "Try again" ]

                                              else
                                                text ""
                                            ]

                            LanguagesTab ->
                                main_ [ id "languages-panel", attribute "role" "tabpanel", attribute "aria-labelledby" "languages-tab" ]
                                    [ Html.map LanguagesMsg
                                        (Languages.view duration
                                            (if m.light then
                                                Theme.light

                                             else
                                                Theme.dark
                                            )
                                            m.languages
                                        )
                                    ]
                        ]
            ]
        ]


tabId : Tab -> String
tabId tab =
    case tab of
        ObserverTab ->
            "observer-tab"

        LanguagesTab ->
            "languages-tab"


viewTabs : Tab -> Html Msg
viewTabs active =
    let
        keydown =
            D.field "key" D.string
                |> D.andThen
                    (\key ->
                        case key of
                            "ArrowLeft" ->
                                D.succeed ( SelectTab (if active == ObserverTab then LanguagesTab else ObserverTab), True )

                            "ArrowRight" ->
                                D.succeed ( SelectTab (if active == ObserverTab then LanguagesTab else ObserverTab), True )

                            "Home" ->
                                D.succeed ( SelectTab ObserverTab, True )

                            "End" ->
                                D.succeed ( SelectTab LanguagesTab, True )

                            _ ->
                                D.fail "Not a tab navigation key"
                    )

        tabButton tab caption panel =
            button
                [ id (tabId tab)
                , attribute "role" "tab"
                , attribute "aria-selected" (if active == tab then "true" else "false")
                , attribute "tabindex" (if active == tab then "0" else "-1")
                , attribute "aria-controls" panel
                , onClick (SelectTab tab)
                , preventDefaultOn "keydown" keydown
                ]
                [ text caption ]
    in
    div [ class "dashboard-tabs", attribute "role" "tablist", attribute "aria-label" "Dashboard views" ]
        [ tabButton ObserverTab "Observer" "observer-panel", tabButton LanguagesTab "Languages" "languages-panel" ]


dashboard : Model -> D.Value -> Html Msg
dashboard m snapshot =
    let
        devices =
            rows "devices" snapshot

        people =
            rows "people" snapshot

        daily =
            rows "daily" snapshot

        theme =
            if m.light then
                Theme.light

            else
                Theme.dark

        days =
            List.map (\d -> { date = str "date" d, seconds = num "seconds" d, regular = num "regularSeconds" d, shorts = num "shortSeconds" d }) daily

        scope =
            people
                |> List.filter (\p -> str "id" p == m.personFilter)
                |> List.head
                |> Maybe.map (str "name")
                |> Maybe.withDefault
                    (if m.personFilter == "unassigned" then
                        "Unassigned devices"

                     else
                        "Everyone"
                    )

        tile caption figure elementId note =
            div
                [ class
                    ("card tile"
                        ++ (if elementId == "watch-total" then
                                " accent"

                            else
                                ""
                           )
                    )
                , title note
                ]
                [ span [ class "eyebrow" ] [ text caption ], span [ class "figure", id elementId ] [ text figure ] ]

        count key =
            String.fromInt (round (num key snapshot))
    in
    main_ [ class "observer-content", id "observer-panel", attribute "role" "tabpanel", attribute "aria-labelledby" "observer-tab" ]
        [ div [ class "spread wrap scope-toolbar" ]
            [ div [ class "toolbar" ]
                [ select [ id "person-filter", value m.personFilter, onInput (Filter "person"), attribute "aria-label" "Person" ] (choice m.personFilter "" "All people" :: choice m.personFilter "unassigned" "Unassigned devices" :: List.map (\p -> choice m.personFilter (str "id" p) (str "name" p)) people)
                , select [ id "device-filter", value m.device, onInput (Filter "device"), attribute "aria-label" "Device" ] (choice m.device "" "All this person’s devices" :: List.map (\d -> choice m.device (str "id" d) (str "label" d)) (List.filter (matchesPerson m.personFilter) devices))
                ]
            , div [ class "toolbar" ]
                [ div [ class "range-buttons", attribute "aria-label" "Date range" ]
                    (List.map
                        (\n ->
                            button
                                [ onClick (Filter "days" n)
                                , attribute "aria-pressed"
                                    (if m.days == n then
                                        "true"

                                     else
                                        "false"
                                    )
                                ]
                                [ text (n ++ " days") ]
                        )
                        [ "7", "30", "90" ]
                    )
                , button [ class "button", onClick Refresh ] [ text "Refresh" ]
                ]
            ]
        , div [ class "spread wrap scope-caption" ]
            [ p [ class "muted" ] [ strong [] [ text scope ], text (" · " ++ (List.head days |> Maybe.map (.date >> Date.short) |> Maybe.withDefault "") ++ " to " ++ (List.reverse days |> List.head |> Maybe.map (.date >> Date.short) |> Maybe.withDefault "") ++ " · " ++ str "timezone" snapshot) ]
            , span [ class "micro muted" ]
                [ text
                    (if m.anchor == Nothing then
                        "Live · refreshes every 15s"

                     else
                        "History snapshot · Refresh for new uploads"
                    )
                ]
            ]
        , div [ class "people-stats" ]
            (List.map
                (\p ->
                    button
                        [ class
                            (if m.personFilter == str "id" p then
                                "person-stat selected-person"

                             else
                                "person-stat"
                            )
                        , onClick (Filter "person" (str "id" p))
                        , attribute "aria-pressed"
                            (if m.personFilter == str "id" p then
                                "true"

                             else
                                "false"
                            )
                        , title "All this person's devices over the selected date range"
                        ]
                        [ strong [] [ text (str "name" p) ], span [ class "figure" ] [ text (duration (num "seconds" p)) ], small [] [ text (String.fromInt (round (num "deviceCount" p)) ++ " devices · " ++ String.fromInt (round (num "videoCount" p)) ++ " videos") ] ]
                )
                people
            )
        , section [ class "tiles" ]
            [ tile "Playback time" (duration (num "seconds" snapshot)) "watch-total" "Measured playback, including background listening. Replays count; ads and paused playback do not."
            , tile "Daily average" (duration (num "seconds" snapshot / toFloat (max 1 (List.length days)))) "daily-average" "Recorded time divided by all calendar days in this range, including days without recordings."
            , a [ class "tile-link", href "#watched-videos", onClick ShowHistory ]
                [ tile "Videos watched ↗" (count "videoCount") "video-total" "Distinct video IDs in the full selected range, including Shorts."
                ]
            , tile
                (if m.personFilter == "" || m.personFilter == "unassigned" then
                    "Completed viewings"

                 else
                    "Completed videos"
                )
                (count "completedCount")
                "completed-total"
                "90% unique media coverage within this range, counted once per person and video. Different people's coverage never combines."
            , tile "Days with activity" (count "activeDays" ++ " / " ++ m.days) "active-days" "Days with recorded watch time. Empty days do not establish that collection was running."
            , tile "Searches made" (count "searchCount") "search-total" "All recorded searches in this person/device/date scope."
            ]
        , section [ class "card playback-context", id "playback-context" ]
            [ div [ class "spread wrap" ] [ h2 [] [ text "On-tab & background" ], span [ class "micro muted" ] [ text "Both included in playback time" ] ]
            , div [ class "context-totals" ]
                (List.map (\( key, caption ) -> div [ class ("context-total " ++ key) ] [ span [ class "eyebrow" ] [ text caption ], strong [ class "figure", id key ] [ text (duration (num key snapshot)) ] ]) [ ( "foregroundSeconds", "On-tab" ), ( "backgroundSeconds", "Background" ), ( "unspecifiedSeconds", "Unspecified · older data" ) ])
            , p [ class "micro muted" ] [ text "On-tab means the browser reported the YouTube tab as visible; background means hidden. This describes playback context, not attention. Older collectors excluded background time and did not save a context label." ]
            ]
        , section [ class "card", id "watch-chart" ]
            [ div [ class "spread chart-heading" ] [ h2 [] [ text "Watch minutes per day" ], div [ class "chart-legend" ] [ span [] [ span [ class "dot", style "background" (theme.fill De) ] [], text "Videos" ], span [] [ span [ class "dot", style "background" (theme.fill Bcs) ] [], text "Shorts" ] ] ]
            , Charts.bars theme days
            , p [ class "micro muted chart-note" ] [ text "Each column is one calendar day. Empty days mean no recorded playback; collection may not have been running. Totals cover the full range, across every history page." ]
            ]
        , div [ class "chart-row" ]
            [ section [ class "card" ] [ h2 [] [ text "Watch time accumulated" ], Charts.cumulative theme days ]
            , section [ class "card" ] [ h2 [] [ text "Videos & Shorts" ], Charts.split theme (num "regularSeconds" snapshot) (num "shortSeconds" snapshot) ]
            ]
        , history m snapshot
        , section [ class "card stack", id "searches" ]
            [ div [ class "spread" ] [ h2 [] [ text "Searches" ], span [ class "micro muted" ] [ text ("Latest " ++ String.fromInt (List.length (rows "searches" snapshot)) ++ " of " ++ count "searchCount" ++ " in this range") ] ]
            , if List.isEmpty (rows "searches" snapshot) then
                p [ class "empty muted" ] [ text "Recorded YouTube searches will appear here." ]

              else
                div [ class "table-scroll" ] [ table [] [ thead [] [ tr [] (List.map (\s -> th [] [ text s ]) [ "Query", "Person", "Device", "Time" ]) ], tbody [] (List.map (\s -> tr [] [ td [] [ text (str "query" s) ], td [] [ text (str "person" s) ], td [] [ text (str "device" s) ], td [ class "muted" ] [ text (str "timeLabel" s) ] ]) (rows "searches" snapshot)) ] ]
            ]
        , details [ class "card", id "delivery" ]
            [ summary [] [ text "Collector delivery & recent events" ]
            , p [ class "muted" ] [ text "Browsers attempt uploads every 30 seconds; this page refreshes every 15 seconds. Only server-saved events appear here. Open the extension popup for its local queue, next batch, retry timer and upload errors." ]
            , div [ class "receipt-devices" ]
                (List.map
                    (\d ->
                        div [ class "receipt-device" ]
                            [ strong [] [ text (str "label" d) ]
                            , span []
                                [ text
                                    (if num "lastSeen" d > 0 then
                                        "Last batch accepted " ++ ago (num "until" snapshot) (num "lastSeen" d)

                                     else
                                        "No batch received yet — pair the collector and refresh YouTube."
                                    )
                                ]
                            ]
                    )
                    (List.filter (\d -> (m.device == "" || str "id" d == m.device) && matchesPerson m.personFilter d) devices)
                )
            , details []
                [ summary [] [ text "What do these event types mean?" ]
                , ul [ class "muted" ]
                    [ li [] [ text "Viewing record: cumulative elapsed playback. A newer revision replaces its total; it does not add the full total again. Older watch segments remain included." ]
                    , li [] [ text "Search: a YouTube search query. No watch time is added." ]
                    , li [] [ text "YouTube reports: supplemental playback, quality or caption evidence. They add zero watch time. QoE means quality of experience: buffering, bandwidth, formats, positions and internal visibility states." ]
                    ]
                ]
            , h3 [] [ text "Recently captured events received by the server" ]
            , if List.isEmpty (rows "recent" snapshot) then
                p [ class "muted" ] [ text "No events in this date/device range yet. If the collector shows queued events, use Upload now in its popup." ]

              else
                div [ class "activity" ] (List.map (activityRow snapshot) (List.take 12 (rows "recent" snapshot)))
            ]
        , details [ class "card", id "management" ]
            [ summary [] [ text "People & devices" ]
            , section [ class "management-section stack" ]
                [ h2 [] [ text "People" ]
                , p [ class "muted" ] [ text "One owner login. Each person’s statistics combine all devices assigned to them. Person cards always summarize all their devices for the selected date range." ]
                , form [ class "toolbar", onSubmit CreatePerson ] [ input [ id "person-name", placeholder "Person name", value m.personName, onInput PersonName, required True, maxlength 100 ] [], button [ disabled m.busy ] [ text "Add person" ] ]
                ]
            , section [ class "management-section stack" ]
                [ h2 [] [ text "Devices" ]
                , p [ class "muted" ] [ text "Building an Android collector? ", a [ href "/android-integration.html", target "_blank", rel "noopener" ] [ text "Read the agent integration guide" ], text " for pairing, event formats and reliable uploads." ]
                , div [ class "devices" ]
                    (List.map
                        (\d ->
                            div [ class "device" ]
                                [ strong [] [ text (str "label" d) ]
                                , span [ class "muted" ] [ text (str "person" d) ]
                                , button [ onClick (EditDevice (str "id" d)), disabled m.busy ] [ text "Assign / rename" ]
                                , button [ onClick (Rotate (str "id" d)), disabled m.busy ] [ text "Replace key" ]
                                , if get D.bool False "revoked" d then
                                    span [] [ text "Revoked" ]

                                  else
                                    button [ onClick (Revoke (str "id" d)) ] [ text "Revoke key" ]
                                ]
                        )
                        devices
                    )
                , case m.editing of
                    Nothing ->
                        text ""

                    Just d ->
                        form [ class "device-edit toolbar", onSubmit SaveDevice ] [ input [ id "edit-label", value d.label, onInput EditLabel, required True, maxlength 100, attribute "aria-label" "Device label" ] [], personSelect "edit-person" d.person EditPerson people, button [ disabled m.busy ] [ text "Save device" ] ]
                , p [ class "muted" ] [ text "Assigning a device changes which person owns its entire history. Replace key invalidates the old key immediately; paste the replacement into the same collector to resume its pending uploads." ]
                , form [ class "toolbar", onSubmit Create ] [ input [ id "device-label", placeholder "Device label, e.g. My laptop", value m.label, onInput Label, required True, maxlength 100 ] [], personSelect "device-person" m.person Person people, button [ disabled m.busy ] [ text "Create device" ] ]
                , if m.pairing == "" then
                    text ""

                  else
                    div [ class "pairing" ] [ p [] [ text ("Key for device " ++ m.pairingDevice ++ ". Copy it into that collector’s connection settings. It is shown only now.") ], input [ id "device-key", readonly True, value m.pairing, attribute "aria-label" "New device key" ] [] ]
                ]
            ]
        , details [ class "card" ]
            [ summary [] [ text "Recent events & raw evidence" ]
            , p [ class "muted" ] [ text "Raw event links include their source snapshot. Export is paginated: follow next with ?after=next until events is empty." ]
            , a [ href "/api/export", target "_blank", rel "noopener" ] [ text "Open JSON export" ]
            , div [ class "activity" ] (List.map (activityRow snapshot) (rows "recent" snapshot))
            ]
        , footer [ class "dashboard-footer" ] [ span [] [ text "Measured playback · on-tab & background · replays count · ads excluded" ], span [] [ text "Original events & source evidence retained" ] ]
        ]


history : Model -> D.Value -> Html Msg
history m snapshot =
    section [ class "card stack watch-history", id "watched-videos" ]
        ([ div [ class "spread wrap" ]
            [ div [] [ h2 [] [ text "Watched videos" ], p [ class "micro muted" ] [ text "Combined across each person’s devices. Coverage and completion are measured within the selected range." ] ]
            , button
                [ class "button"
                , onClick ToggleHistory
                , attribute "aria-expanded"
                    (if m.historyOpen then
                        "true"

                     else
                        "false"
                    )
                , attribute "aria-controls" "history-content"
                ]
                [ text
                    (if m.historyOpen then
                        "Hide videos"

                     else
                        "Show videos"
                    )
                ]
            ]
         ]
            ++ (if not m.historyOpen then
                    []

                else
                    [ div [ id "history-content", class "stack" ]
                        [ div [ class "history-filters" ]
                            [ label [] [ span [ class "eyebrow" ] [ text "Find a video" ], input [ id "history-query", type_ "search", value m.query, onInput (Filter "query"), maxlength 200, placeholder "Title, channel or video ID" ] [] ]
                            , label [] [ span [ class "eyebrow" ] [ text "Format" ], select [ id "history-kind", value m.kind, onInput (Filter "kind") ] (List.map (\( key, caption ) -> choice m.kind key caption) [ ( "all", "Videos & Shorts" ), ( "video", "Videos" ), ( "short", "Shorts" ) ]) ]
                            , label [] [ span [ class "eyebrow" ] [ text "Sort by" ], select [ id "history-sort", value m.sort, onInput (Filter "sort") ] (List.map (\( key, caption ) -> choice m.sort key caption) [ ( "recent", "Last watched" ), ( "watch", "Watch time" ), ( "title", "Title" ) ]) ]
                            ]
                        , p [ class "micro muted" ] [ text "One row per person and video; unassigned devices remain separate. History filters affect this list only, not the summary cards or charts." ]
                        , pagination m snapshot
                        , if List.isEmpty (rows "videos" snapshot) then
                            p [ class "empty muted" ]
                                [ text
                                    (if num "historyCount" snapshot == 0 then
                                        "No recorded videos in this scope yet. Pair a collector under People & devices, then watch a video or Short."

                                     else
                                        "No videos match these history filters."
                                    )
                                ]

                          else
                            div [ class "table-scroll" ]
                                [ table [ id "watch-table" ]
                                    [ thead [] [ tr [] (List.map (\caption -> th [ attribute "scope" "col" ] [ text caption ]) [ "Video", "Person", "Watched", "Length", "Coverage", "Last watched", "Evidence" ]) ]
                                    , Html.Keyed.node "tbody" [] (List.map (\v -> ( str "historyId" v, video v )) (rows "videos" snapshot))
                                    ]
                                ]
                        , pagination m snapshot
                        ]
                    ]
               )
        )


matchesPerson : String -> D.Value -> Bool
matchesPerson selected device =
    selected == "" || str "personId" device == selected || (selected == "unassigned" && str "personId" device == "")


personSelect : String -> String -> (String -> Msg) -> List D.Value -> Html Msg
personSelect elementId selected change people =
    select [ id elementId, value selected, onInput change, attribute "aria-label" "Assign to person" ]
        (choice selected "" "Unassigned" :: List.map (\p -> choice selected (str "id" p) (str "name" p)) people)


choice : String -> String -> String -> Html msg
choice current key caption =
    option [ attribute "value" key, Html.Attributes.selected (current == key) ] [ text caption ]


pagination : Model -> D.Value -> Html Msg
pagination m snapshot =
    let
        page =
            round (num "page" snapshot)

        pages =
            round (num "pages" snapshot)
    in
    div [ class "pagination toolbar" ]
        [ button [ onClick (GoPage (page - 1)), disabled (page <= 1) ] [ text "Previous" ]
        , span [ class "page-label" ] [ text ("Page " ++ String.fromInt page ++ " of " ++ String.fromInt pages ++ " · " ++ String.fromInt (round (num "filteredCount" snapshot)) ++ " records") ]
        , button [ onClick (GoPage (page + 1)), disabled (page >= pages) ] [ text "Next" ]
        , select [ value m.perPage, onInput (Filter "perPage"), attribute "aria-label" "Videos per page" ] (List.map (\n -> choice m.perPage n (n ++ " per page")) [ "10", "20", "50" ])
        ]


ago : Float -> Float -> String
ago current at =
    let
        seconds =
            max 0 ((current - at) / 1000)
    in
    if seconds < 60 then
        String.fromInt (floor seconds) ++ "s ago"

    else if seconds < 3600 then
        String.fromInt (floor (seconds / 60)) ++ "m ago"

    else if seconds < 86400 then
        String.fromInt (floor (seconds / 3600)) ++ "h ago"

    else
        String.fromInt (floor (seconds / 86400)) ++ "d ago"


eventName : D.Value -> String
eventName e =
    case str "kind" e of
        "watch" ->
            if str "detailUrl" e /= "" then
                "Cumulative viewing"

            else
                "Watch segment"

        "search" ->
            "YouTube search"

        _ ->
            case str "endpoint" e of
                "qoe" ->
                    "Playback-quality report (QoE)"

                "watchtime" ->
                    "YouTube-reported media ranges"

                "playback" ->
                    "YouTube playback report"

                "timedtext" ->
                    "Caption request"

                _ ->
                    "Supplemental YouTube report"


activityRow : D.Value -> D.Value -> Html Msg
activityRow snapshot e =
    let
        deviceName =
            rows "devices" snapshot |> List.filter (\d -> str "id" d == str "deviceId" e) |> List.head |> Maybe.map (str "label") |> Maybe.withDefault "Device"

        subject =
            if str "title" e /= "" then
                str "title" e

            else if str "query" e /= "" then
                str "query" e

            else
                str "videoId" e

        contribution =
            if str "detailUrl" e /= "" then
                duration (num "seconds" e) ++ " watch time · cumulative"

            else if str "kind" e == "watch" then
                "+" ++ String.fromFloat (toFloat (round (num "seconds" e * 1000)) / 1000) ++ "s watch time"

            else
                "0s added · supplemental"
    in
    article [ class "activity-row" ]
        [ div [] [ strong [] [ text (eventName e) ], p [] [ text subject ], small [] [ text (deviceName ++ " · received " ++ ago (num "until" snapshot) (num "receivedAt" e)) ] ]
        , div []
            [ span
                [ class
                    (if str "kind" e == "watch" then
                        "badge"

                     else
                        "muted"
                    )
                ]
                [ text contribution ]
            , a [ href (if str "detailUrl" e /= "" then str "detailUrl" e else "/api/events/" ++ String.fromInt (round (num "seq" e))), target "_blank", rel "noopener" ] [ text "Raw details ↗" ]
            ]
        ]


video : D.Value -> Html Msg
video v =
    let
        short =
            get D.bool False "isShort" v

        length =
            num "durationSeconds" v

        percentage =
            if length > 0 then
                min 100 (num "coveredSeconds" v / length * 100)

            else
                0

        finished =
            get D.bool False "completed" v
    in
    tr [ class "video" ]
        [ td [ class "video-title" ]
            [ a
                [ class "video-link"
                , href
                    ((if short then
                        "https://www.youtube.com/shorts/"

                      else
                        "https://www.youtube.com/watch?v="
                     )
                        ++ str "videoId" v
                    )
                , target "_blank"
                , rel "noreferrer"
                ]
                [ text
                    (if str "title" v == "" then
                        str "videoId" v

                     else
                        str "title" v
                    )
                ]
            , span [ class "micro muted" ]
                [ text
                    ((if short then
                        "Short · "

                      else
                        "Video · "
                     )
                        ++ (if str "channel" v == "" then
                                "Channel not recorded"

                            else
                                str "channel" v
                           )
                    )
                ]
            ]
        , td [] [ text (str "person" v) ]
        , td [ class "watch-duration" ]
            [ strong [ class "figure" ] [ text (duration (num "seconds" v)) ]
            , div [ class "micro muted context-row" ] [ text ("On-tab " ++ duration (num "foregroundSeconds" v)) ]
            , div [ class "micro muted context-row" ] [ text ("Background " ++ duration (num "backgroundSeconds" v)) ]
            , if num "unspecifiedSeconds" v > 0 then
                div [ class "micro muted context-row" ] [ text ("Unspecified " ++ duration (num "unspecifiedSeconds" v)) ]

              else
                text ""
            ]
        , td [ class "video-length figure" ]
            [ text
                (if length > 0 then
                    duration length

                 else
                    "Unknown"
                )
            ]
        , td [ class "video-progress" ]
            [ if length <= 0 then
                span [ class "muted" ] [ text "Unknown" ]

              else
                div [ class "stack", style "gap" "6px" ]
                    [ span
                        [ class
                            (if finished then
                                "finished-label"

                             else
                                "muted"
                            )
                        ]
                        [ text
                            ((if finished then
                                "Finished · "

                              else
                                ""
                             )
                                ++ String.fromInt (floor percentage)
                                ++ "%"
                            )
                        ]
                    , div [ class "completion-track", attribute "aria-label" (String.fromInt (floor percentage) ++ "% unique coverage") ] [ span [ style "width" (String.fromFloat percentage ++ "%") ] [] ]
                    , span [ class "micro muted" ] [ text (duration (num "coveredSeconds" v) ++ " played") ]
                    ]
            ]
        , td [ class "micro muted" ] [ text (str "lastWatchedLabel" v) ]
        , td [ class "video-evidence" ] [ button [ class "evidence-trigger", onClick (ShowEvidence v), attribute "aria-haspopup" "dialog" ] [ text "Evidence ↗" ] ]
        ]
