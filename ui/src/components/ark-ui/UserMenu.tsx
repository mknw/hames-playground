import { Avatar } from '@ark-ui/solid/avatar'
import { Menu } from '@ark-ui/solid/menu'
import { Show } from 'solid-js'
import { useAuth } from '~/components/AuthProvider'

export const UserMenu = () => {
  const { user, signOut } = useAuth()

  const getInitials = (name: string | null, email: string | null) => {
    if (name) {
      return name
        .split(' ')
        .map(n => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    }
    if (email) {
      return email[0].toUpperCase()
    }
    return 'U'
  }

  const handleSignOut = async () => {
    await signOut()
  }

  return (
    <Show when={user()}>
      {(currentUser) => (
        <Menu.Root>
          <Menu.Trigger flex items-center gap-2 cursor-pointer opacity="hover:80" transition-opacity>
            <Avatar.Root w-8 h-8 rounded-full overflow-hidden border="2 white/20">
              <Avatar.Fallback bg-sky-700 text="white sm" font-medium flex items-center justify-center w-full h-full>
                {getInitials(currentUser().displayName, currentUser().email)}
              </Avatar.Fallback>
              <Show when={currentUser().profileImageUrl}>
                <Avatar.Image
                  src={currentUser().profileImageUrl!}
                  alt={currentUser().displayName || 'User avatar'}
                  w-full h-full object-cover
                />
              </Show>
            </Avatar.Root>
            <span text="gray-200 sm" font-medium hidden sm:block>
              {currentUser().displayName || currentUser().email}
            </span>
          </Menu.Trigger>

          <Menu.Positioner>
            <Menu.Content bg-white rounded-lg shadow-lg border="~ gray-200" min-w-48 p="y-2" z-50>
              <Menu.Item
                value="profile"
                p="x-4 y-2"
                text-gray-700
                bg="hover:gray-100"
                cursor-pointer
                transition-colors
              >
                <a href="/profile" block w-full>Profile Settings</a>
              </Menu.Item>

              <Menu.Separator m="y-2" border="t gray-200" />

              <Menu.Item
                value="logout"
                onClick={handleSignOut}
                p="x-4 y-2"
                text-red-600
                bg="hover:red-50"
                cursor-pointer
                transition-colors
              >
                Sign Out
              </Menu.Item>
            </Menu.Content>
          </Menu.Positioner>
        </Menu.Root>
      )}
    </Show>
  )
}
