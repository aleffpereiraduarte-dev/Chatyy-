package expo.modules.chatyyconversationlist

// [2026-10-15 native-social] Casca da view ChatyyCommunityList — o motor é
// CMListBaseView (CMViews.kt). Contrato: ios/ChatyyCommunityListModule.swift.

import android.annotation.SuppressLint
import android.content.Context
import expo.modules.kotlin.AppContext

@SuppressLint("ViewConstructor")
class ChatyyCommunityListView(context: Context, appContext: AppContext) : CMListBaseView(context, appContext)
